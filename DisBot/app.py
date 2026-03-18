import asyncio
import concurrent.futures
import contextlib
import hmac
import logging
import os
import signal
import threading
import time
from datetime import datetime, timezone
from uuid import uuid4

import discord
from dotenv import load_dotenv
from flask import Flask, jsonify, request

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("disbot")

DISCORD_BOT_TOKEN = os.getenv("DISCORD_BOT_TOKEN", "").strip()
USER_ID = int(os.getenv("USER_ID", "0") or "0")
DISBOT_PORT = int(os.getenv("DISBOT_PORT", "5000") or "5000")
API_SHARED_SECRET = os.getenv("API_SHARED_SECRET", "").strip()

DM_TASK_TIMEOUT_SEC = max(3, int(os.getenv("DM_TASK_TIMEOUT_SEC", "12") or "12"))
BOOT_WAIT_SECONDS = max(1, int(os.getenv("BOOT_WAIT_SECONDS", "8") or "8"))

app = Flask(__name__)

intents = discord.Intents.none()
client = discord.Client(intents=intents)

bot_ready_event = threading.Event()
shutdown_event = threading.Event()

state_lock = threading.Lock()
runtime_state = {
    "botReady": False,
    "gatewayConnected": False,
    "loopRunning": False,
    "discordThreadAlive": False,
    "lastReadyAt": None,
    "lastDisconnectAt": None,
    "lastConnectionAttemptAt": None,
    "lastDiscordError": None,
    "startupAt": datetime.now(timezone.utc).isoformat(),
    "loginAttemptCount": 0,
}

discord_loop_lock = threading.Lock()
discord_loop: asyncio.AbstractEventLoop | None = None

discord_thread: threading.Thread | None = None


def utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _token_hint(value: str) -> str:
    if not value:
        return "missing"
    if len(value) < 10:
        return "set(len<10)"
    return f"set(len={len(value)})"


def _safe_error_message(error: Exception) -> str:
    return f"{error.__class__.__name__}: {str(error)[:250]}"


def _set_state(**changes) -> None:
    with state_lock:
        runtime_state.update(changes)


def _get_state_snapshot() -> dict:
    with state_lock:
        return dict(runtime_state)


def _set_discord_loop(loop: asyncio.AbstractEventLoop | None) -> None:
    global discord_loop
    with discord_loop_lock:
        discord_loop = loop


def _get_discord_loop() -> asyncio.AbstractEventLoop | None:
    with discord_loop_lock:
        return discord_loop


def _sanitize_text(value, default: str = "N/A", max_len: int = 180) -> str:
    if value is None:
        return default
    text = str(value).strip()
    if not text:
        return default
    return text[:max_len]


def _build_services_text(services: list[dict]) -> str:
    service_lines = []
    for index, service in enumerate(services, start=1):
        label = _sanitize_text(service.get("label"), default="Servicio", max_len=80)
        price_cop = service.get("priceCop")
        if price_cop is None:
            price_label = "Variable"
        else:
            price_label = f"COP {int(price_cop)}"
        service_lines.append(f"{index}. {label} - {price_label}")
    return "\n".join(service_lines) if service_lines else "Sin servicios"


def log_startup_config() -> None:
    logger.info(
        "startup_config pid=%s token=%s userId=%s port=%s sharedSecret=%s timeoutSec=%s mode=%s",
        os.getpid(),
        _token_hint(DISCORD_BOT_TOKEN),
        USER_ID,
        DISBOT_PORT,
        "set" if API_SHARED_SECRET else "empty",
        DM_TASK_TIMEOUT_SEC,
        "direct-sync",
    )

    if not API_SHARED_SECRET:
        logger.warning(
            "startup_warning API_SHARED_SECRET is empty, authorization bypass enabled"
        )


def _classify_error(error: Exception) -> tuple[bool, str]:
    if isinstance(error, (concurrent.futures.TimeoutError, TimeoutError)):
        return True, "timeout"
    if isinstance(error, discord.HTTPException):
        if error.status == 429 or error.status >= 500:
            return True, "discord-http-transient"
        return False, f"discord-http-{error.status}"
    if isinstance(error, discord.Forbidden):
        return False, "discord-forbidden"
    if isinstance(error, discord.NotFound):
        return False, "discord-not-found"
    if isinstance(error, RuntimeError):
        text = str(error).lower()
        if "loop" in text or "ready" in text or "closed" in text:
            return True, "discord-loop-state"
        if "user_id" in text or "configured" in text:
            return False, "config-user-id"
        return False, "runtime-error"
    if isinstance(error, ValueError):
        return False, "invalid-payload"
    return False, "logic-error"


def _dispatch_dm(payload: dict) -> dict:
    loop = _get_discord_loop()
    if loop is None or not loop.is_running():
        raise RuntimeError("Discord loop is not running.")
    if not bot_ready_event.is_set():
        raise RuntimeError("Bot is not ready.")

    future = asyncio.run_coroutine_threadsafe(send_order_dm(payload), loop)
    return future.result(timeout=DM_TASK_TIMEOUT_SEC)


async def send_order_dm(payload: dict) -> dict:
    if USER_ID <= 0:
        raise RuntimeError("USER_ID is not configured.")

    order_id = _sanitize_text(payload.get("orderId"), default="N/A", max_len=64)
    usuario = _sanitize_text(payload.get("usuario"), default="N/A", max_len=120)
    email = _sanitize_text(payload.get("email"), default="N/A", max_len=120)
    metodo_pago = _sanitize_text(payload.get("metodoPago"), default="N/A", max_len=80)
    total_cop = payload.get("totalCop", 0)
    total_usd = payload.get("totalUsd", 0)
    estado = _sanitize_text(payload.get("estado"), default="Cotizacion", max_len=60)
    contacto = payload.get("contacto") or {}
    servicios = payload.get("services") or []

    message = (
        "Nuevo pedido confirmado\n"
        f"Order ID: {order_id}\n"
        f"Usuario: {usuario}\n"
        f"Email: {email}\n"
        f"Contacto: {_sanitize_text(contacto.get('plataforma'))} / {_sanitize_text(contacto.get('contacto'), max_len=120)}\n"
        f"Metodo de pago: {metodo_pago}\n"
        f"Estado: {estado}\n"
        f"Total COP: {total_cop}\n"
        f"Total USD: {total_usd}\n"
        "Servicios:\n"
        f"{_build_services_text(servicios)}"
    )

    user = client.get_user(USER_ID)
    if user is None:
        logger.info("discord_fetch_user userId=%s orderId=%s", USER_ID, order_id)
        user = await asyncio.wait_for(
            client.fetch_user(USER_ID),
            timeout=DM_TASK_TIMEOUT_SEC,
        )

    logger.info(
        "discord_dm_attempt orderId=%s recipientUserId=%s servicesCount=%s",
        order_id,
        USER_ID,
        len(servicios),
    )
    sent_message = await asyncio.wait_for(
        user.send(message),
        timeout=DM_TASK_TIMEOUT_SEC,
    )
    logger.info(
        "discord_dm_sent orderId=%s messageId=%s",
        order_id,
        sent_message.id,
    )
    return {
        "dmSent": True,
        "recipientUserId": USER_ID,
        "messageId": sent_message.id,
        "deliveredAt": utcnow_iso(),
    }


@client.event
async def on_ready():
    bot_ready_event.set()
    _set_state(
        botReady=True,
        gatewayConnected=True,
        lastReadyAt=utcnow_iso(),
        lastDiscordError=None,
    )
    logger.info(
        "discord_on_ready user=%s userId=%s",
        client.user,
        getattr(client.user, "id", "N/A"),
    )


@client.event
async def on_connect():
    _set_state(gatewayConnected=True)
    logger.info("discord_on_connect")


@client.event
async def on_disconnect():
    bot_ready_event.clear()
    _set_state(botReady=False, gatewayConnected=False, lastDisconnectAt=utcnow_iso())
    logger.warning("discord_on_disconnect")


@client.event
async def on_resumed():
    _set_state(gatewayConnected=True, botReady=True)
    bot_ready_event.set()
    logger.info("discord_on_resumed")


@client.event
async def on_error(event_method, *args, **kwargs):
    logger.exception("discord_on_error event=%s", event_method)


def run_discord_runtime() -> None:
    _set_state(discordThreadAlive=True)
    logger.info("discord_thread_started")

    if not DISCORD_BOT_TOKEN:
        _set_state(lastDiscordError="DISCORD_BOT_TOKEN missing", loopRunning=False)
        logger.error("discord_token_missing")
        return
    if USER_ID <= 0:
        _set_state(lastDiscordError="USER_ID invalid", loopRunning=False)
        logger.error("discord_user_id_invalid userId=%s", USER_ID)
        return

    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    _set_discord_loop(loop)
    _set_state(loopRunning=True)

    backoff_seconds = 2
    try:
        while not shutdown_event.is_set():
            _set_state(
                lastConnectionAttemptAt=utcnow_iso(),
                loginAttemptCount=_get_state_snapshot().get("loginAttemptCount", 0) + 1,
            )
            logger.info(
                "discord_login_start reconnect=%s attempt=%s",
                True,
                _get_state_snapshot().get("loginAttemptCount"),
            )
            try:
                loop.run_until_complete(client.start(DISCORD_BOT_TOKEN, reconnect=True))
                if shutdown_event.is_set():
                    break

                logger.warning("discord_start_returned_without_shutdown")
                bot_ready_event.clear()
                _set_state(botReady=False, gatewayConnected=False)
                shutdown_event.wait(2)
                backoff_seconds = min(backoff_seconds * 2, 30)
            except discord.LoginFailure as error:
                _set_state(lastDiscordError=_safe_error_message(error))
                logger.exception("discord_login_failure")
                break
            except Exception as error:
                bot_ready_event.clear()
                _set_state(
                    botReady=False,
                    gatewayConnected=False,
                    lastDiscordError=_safe_error_message(error),
                )
                logger.exception("discord_runtime_error retryIn=%s", backoff_seconds)
                shutdown_event.wait(backoff_seconds)
                backoff_seconds = min(backoff_seconds * 2, 30)
            else:
                backoff_seconds = 2
    finally:
        bot_ready_event.clear()
        with contextlib.suppress(Exception):
            if not client.is_closed():
                loop.run_until_complete(client.close())
        _set_state(loopRunning=False, discordThreadAlive=False)
        _set_discord_loop(None)
        with contextlib.suppress(Exception):
            loop.stop()
        with contextlib.suppress(Exception):
            loop.close()
        logger.info("discord_thread_stopped")


def _shutdown_background_workers() -> None:
    logger.info("shutdown_start")
    shutdown_event.set()

    loop = _get_discord_loop()
    if loop is not None and loop.is_running():
        with contextlib.suppress(Exception):
            asyncio.run_coroutine_threadsafe(client.close(), loop).result(timeout=5)

    if discord_thread is not None and discord_thread.is_alive():
        discord_thread.join(timeout=10)

    logger.info("shutdown_complete")


def _install_signal_handlers() -> None:
    def _handle_signal(signum, frame):
        logger.warning("signal_received signum=%s", signum)
        shutdown_event.set()

    for sig_name in ("SIGTERM", "SIGINT"):
        sig = getattr(signal, sig_name, None)
        if sig is not None:
            signal.signal(sig, _handle_signal)


def wait_for_bot_boot(timeout_seconds: int) -> None:
    logger.info("discord_boot_wait timeoutSec=%s", timeout_seconds)
    started_at = time.time()
    while time.time() - started_at < timeout_seconds:
        if bot_ready_event.is_set():
            logger.info("discord_boot_ready")
            return
        if shutdown_event.is_set():
            return
        time.sleep(0.25)
    logger.warning("discord_boot_timeout timeoutSec=%s", timeout_seconds)


def validate_payload(payload: dict) -> tuple[str | None, dict | None]:
    if not isinstance(payload, dict):
        return "Invalid payload format.", None

    required_keys = ["orderId", "userId"]
    missing = [key for key in required_keys if key not in payload]
    if missing:
        return f"Missing payload fields: {', '.join(missing)}", None

    services = payload.get("services") or []
    if not isinstance(services, list):
        return "services must be a list.", None
    if len(services) > 40:
        return "services exceeds maximum allowed size.", None

    sanitized_services = []
    for service in services:
        if not isinstance(service, dict):
            return "service entries must be objects.", None
        service_id = _sanitize_text(service.get("serviceId"), default="", max_len=64)
        label = _sanitize_text(service.get("label"), default="Servicio", max_len=80)
        price_cop = service.get("priceCop")
        is_variable = bool(service.get("isVariablePrice", False))
        if is_variable:
            price_cop = None
        elif price_cop is not None:
            try:
                price_cop = int(price_cop)
            except (TypeError, ValueError):
                return "priceCop must be an integer or null.", None

        sanitized_services.append(
            {
                "serviceId": service_id,
                "label": label,
                "priceCop": price_cop,
                "isVariablePrice": is_variable,
            }
        )

    try:
        total_cop = int(payload.get("totalCop", 0) or 0)
    except (TypeError, ValueError):
        return "totalCop must be an integer.", None

    try:
        total_usd = float(payload.get("totalUsd", 0) or 0)
    except (TypeError, ValueError):
        return "totalUsd must be a number.", None

    sanitized_payload = {
        "requestId": _sanitize_text(payload.get("requestId"), default="", max_len=64),
        "orderId": _sanitize_text(payload.get("orderId"), default="N/A", max_len=64),
        "userId": _sanitize_text(payload.get("userId"), default="N/A", max_len=64),
        "usuario": _sanitize_text(payload.get("usuario"), default="N/A", max_len=120),
        "email": _sanitize_text(payload.get("email"), default="N/A", max_len=120),
        "contacto": {
            "id": _sanitize_text(
                (payload.get("contacto") or {}).get("id"), default="", max_len=64
            ),
            "plataforma": _sanitize_text(
                (payload.get("contacto") or {}).get("plataforma"), max_len=60
            ),
            "contacto": _sanitize_text(
                (payload.get("contacto") or {}).get("contacto"), max_len=120
            ),
        },
        "metodoPago": _sanitize_text(
            payload.get("metodoPago"), default="N/A", max_len=80
        ),
        "services": sanitized_services,
        "totalCop": total_cop,
        "totalUsd": total_usd,
        "estado": _sanitize_text(
            payload.get("estado"), default="Cotizacion", max_len=60
        ),
    }
    return None, sanitized_payload


def is_authorized(req) -> bool:
    if not API_SHARED_SECRET:
        return True

    incoming_secret = (req.headers.get("x-api-shared-secret") or "").strip()
    is_valid = hmac.compare_digest(incoming_secret, API_SHARED_SECRET)
    if not is_valid:
        logger.warning(
            "http_auth_failed route=/orders/notify remote=%s", req.remote_addr
        )
    return is_valid


@app.get("/health")
def health():
    snapshot = _get_state_snapshot()
    loop = _get_discord_loop()
    loop_running = bool(loop is not None and loop.is_running())
    response = {
        "ok": not shutdown_event.is_set(),
        "service": "disbot",
        "botReady": bot_ready_event.is_set(),
        "gatewayConnected": snapshot.get("gatewayConnected", False),
        "loopRunning": loop_running,
        "discordThreadAlive": snapshot.get("discordThreadAlive", False),
        "lastReadyAt": snapshot.get("lastReadyAt"),
        "lastDisconnectAt": snapshot.get("lastDisconnectAt"),
        "lastConnectionAttemptAt": snapshot.get("lastConnectionAttemptAt"),
        "lastDiscordError": snapshot.get("lastDiscordError"),
        "loginAttemptCount": snapshot.get("loginAttemptCount", 0),
        "uptimeStartedAt": snapshot.get("startupAt"),
    }
    return jsonify(response), 200


@app.get("/")
def root_health():
    return health()


@app.post("/orders/notify")
def notify_order():
    request_id = str(uuid4())
    logger.info(
        "http_request_received requestId=%s route=/orders/notify method=%s remote=%s",
        request_id,
        request.method,
        request.remote_addr,
    )

    if not is_authorized(request):
        return jsonify({"success": False, "error": "Unauthorized."}), 401

    payload = request.get_json(silent=True) or {}
    logger.info(
        "http_payload_received requestId=%s orderId=%s keys=%s",
        request_id,
        _sanitize_text(payload.get("orderId"), default="N/A", max_len=64),
        sorted(payload.keys()),
    )

    validation_error, sanitized_payload = validate_payload(payload)
    if validation_error:
        logger.warning(
            "http_payload_invalid requestId=%s error=%s",
            request_id,
            validation_error,
        )
        return jsonify({"success": False, "error": validation_error}), 400

    try:
        _dispatch_dm(sanitized_payload)
        logger.info(
            "http_dispatch_success requestId=%s orderId=%s userId=%s",
            request_id,
            sanitized_payload.get("orderId", "N/A"),
            sanitized_payload.get("userId", "N/A"),
        )
        return jsonify({"success": True}), 200
    except Exception as error:
        retryable, reason = _classify_error(error)
        logger.warning(
            "http_dispatch_failed requestId=%s orderId=%s retryable=%s reason=%s",
            request_id,
            sanitized_payload.get("orderId", "N/A"),
            retryable,
            reason,
        )
        status = 503 if retryable else 400
        return jsonify({"success": False, "error": reason}), status


if __name__ == "__main__":
    log_startup_config()
    _install_signal_handlers()

    discord_thread = threading.Thread(
        target=run_discord_runtime,
        name="discord-runtime-thread",
        daemon=False,
    )

    logger.info("thread_start name=%s", discord_thread.name)
    discord_thread.start()

    wait_for_bot_boot(timeout_seconds=BOOT_WAIT_SECONDS)

    try:
        logger.info(
            "http_server_start host=0.0.0.0 port=%s pid=%s thread=%s",
            DISBOT_PORT,
            os.getpid(),
            threading.current_thread().name,
        )
        app.run(
            host="0.0.0.0",
            port=DISBOT_PORT,
            threaded=True,
            use_reloader=False,
        )
    finally:
        _shutdown_background_workers()
