import asyncio
import concurrent.futures
import logging
import os
import threading
import time
from datetime import datetime, timezone

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

app = Flask(__name__)

intents = discord.Intents.none()
client = discord.Client(intents=intents)

bot_ready_event = threading.Event()


def _token_hint(value: str) -> str:
    if not value:
        return "missing"
    if len(value) < 10:
        return "set(len<10)"
    return f"set(len={len(value)})"


def log_startup_config() -> None:
    logger.info(
        "Startup config | DISCORD_BOT_TOKEN=%s USER_ID=%s DISBOT_PORT=%s API_SHARED_SECRET=%s",
        _token_hint(DISCORD_BOT_TOKEN),
        USER_ID,
        DISBOT_PORT,
        "set" if API_SHARED_SECRET else "empty",
    )


@client.event
async def on_ready():
    logger.info(
        "Discord bot ready | user=%s user_id=%s",
        client.user,
        getattr(client.user, "id", "N/A"),
    )
    bot_ready_event.set()


@client.event
async def on_connect():
    logger.info("Discord gateway connected.")


@client.event
async def on_disconnect():
    logger.warning("Discord gateway disconnected.")


@client.event
async def on_resumed():
    logger.info("Discord gateway session resumed.")


@client.event
async def on_error(event_method, *args, **kwargs):
    logger.exception("Unhandled Discord event error | event=%s", event_method)


async def send_order_dm(payload: dict) -> dict:
    if USER_ID <= 0:
        raise RuntimeError("USER_ID is not configured.")

    order_id = payload.get("orderId", "N/A")
    usuario = payload.get("usuario", "N/A")
    email = payload.get("email", "N/A")
    metodo_pago = payload.get("metodoPago", "N/A")
    total_cop = payload.get("totalCop", 0)
    total_usd = payload.get("totalUsd", 0)
    estado = payload.get("estado", "Cotizacion")
    contacto = payload.get("contacto") or {}
    servicios = payload.get("services") or []

    service_lines = []
    for index, service in enumerate(servicios, start=1):
        label = service.get("label", "Servicio")
        price_cop = service.get("priceCop")
        if price_cop is None:
            price_label = "Variable"
        else:
            price_label = f"COP {int(price_cop)}"
        service_lines.append(f"{index}. {label} - {price_label}")

    services_text = "\n".join(service_lines) if service_lines else "Sin servicios"

    message = (
        "Nuevo pedido confirmado\n"
        f"Order ID: {order_id}\n"
        f"Usuario: {usuario}\n"
        f"Email: {email}\n"
        f"Contacto: {contacto.get('plataforma', 'N/A')} / {contacto.get('contacto', 'N/A')}\n"
        f"Metodo de pago: {metodo_pago}\n"
        f"Estado: {estado}\n"
        f"Total COP: {total_cop}\n"
        f"Total USD: {total_usd}\n"
        "Servicios:\n"
        f"{services_text}"
    )

    user = client.get_user(USER_ID)
    if user is None:
        logger.info("User not present in cache, fetching via API | USER_ID=%s", USER_ID)
        user = await client.fetch_user(USER_ID)

    logger.info(
        "Sending DM | orderId=%s recipientUserId=%s servicesCount=%s",
        order_id,
        USER_ID,
        len(servicios),
    )
    sent_message = await user.send(message)
    logger.info(
        "DM sent successfully | orderId=%s messageId=%s", order_id, sent_message.id
    )

    return {
        "accepted": True,
        "dmSent": True,
        "recipientUserId": USER_ID,
        "messageId": sent_message.id,
        "deliveredAt": datetime.now(timezone.utc).isoformat(),
    }


def validate_payload(payload: dict) -> str | None:
    if not isinstance(payload, dict):
        return "Invalid payload format."

    required_keys = [
        "orderId",
        "usuario",
        "metodoPago",
        "services",
        "totalCop",
        "totalUsd",
    ]
    missing = [key for key in required_keys if key not in payload]
    if missing:
        return f"Missing payload fields: {', '.join(missing)}"

    if (
        not isinstance(payload.get("services"), list)
        or len(payload.get("services")) < 1
    ):
        return "services must be a non-empty list."

    return None


def is_authorized(req) -> bool:
    if not API_SHARED_SECRET:
        logger.info("Auth bypass enabled because API_SHARED_SECRET is empty.")
        return True

    incoming_secret = (req.headers.get("x-api-shared-secret") or "").strip()
    is_valid = incoming_secret == API_SHARED_SECRET
    if not is_valid:
        logger.warning(
            "Authorization failed for /orders/notify | missing_or_invalid_secret=true"
        )
    return is_valid


@app.get("/health")
def health():
    logger.info(
        "Health check | botReady=%s thread=%s",
        bot_ready_event.is_set(),
        threading.current_thread().name,
    )
    return jsonify(
        {
            "ok": True,
            "service": "disbot",
            "botReady": bot_ready_event.is_set(),
        }
    )


@app.get("/")
def root_health():
    logger.info(
        "Root check | botReady=%s thread=%s",
        bot_ready_event.is_set(),
        threading.current_thread().name,
    )
    return jsonify(
        {
            "ok": True,
            "service": "disbot",
            "botReady": bot_ready_event.is_set(),
        }
    )


@app.post("/orders/notify")
def notify_order():
    logger.info(
        "Incoming /orders/notify request | method=%s remote=%s",
        request.method,
        request.remote_addr,
    )
    if not is_authorized(request):
        return jsonify({"accepted": False, "error": "Unauthorized."}), 401

    if not bot_ready_event.is_set():
        return jsonify({"accepted": False, "error": "Bot is not ready yet."}), 503

    payload = request.get_json(silent=True) or {}
    logger.info(
        "Payload received | orderId=%s keys=%s",
        payload.get("orderId", "N/A"),
        sorted(payload.keys()),
    )
    validation_error = validate_payload(payload)
    if validation_error:
        logger.warning("Payload validation failed | error=%s", validation_error)
        return jsonify({"accepted": False, "error": validation_error}), 400

    try:
        future = asyncio.run_coroutine_threadsafe(send_order_dm(payload), client.loop)
        result = future.result(timeout=12)
        return jsonify(result), 200
    except concurrent.futures.TimeoutError:
        logger.exception(
            "Discord DM timeout | orderId=%s", payload.get("orderId", "N/A")
        )
        return jsonify({"accepted": False, "error": "Discord DM timeout."}), 504
    except Exception as error:
        logger.exception(
            "Discord DM failed | orderId=%s error=%s",
            payload.get("orderId", "N/A"),
            error,
        )
        return jsonify({"accepted": False, "error": f"Discord DM failed: {error}"}), 502


def run_bot():
    if not DISCORD_BOT_TOKEN:
        logger.error("DISCORD_BOT_TOKEN is missing at startup.")
        raise RuntimeError("DISCORD_BOT_TOKEN is required.")
    if USER_ID <= 0:
        logger.error("USER_ID is invalid at startup | USER_ID=%s", USER_ID)
        raise RuntimeError("USER_ID is required and must be > 0.")
    logger.info("Starting Discord client loop.")
    client.run(DISCORD_BOT_TOKEN)


def wait_for_bot_boot(timeout_seconds: int = 30) -> None:
    logger.info("Waiting for bot readiness | timeout_seconds=%s", timeout_seconds)
    start = time.time()
    while time.time() - start < timeout_seconds:
        if bot_ready_event.is_set():
            logger.info("Bot readiness confirmed before timeout.")
            return
        time.sleep(0.25)
    logger.warning(
        "Bot did not become ready before timeout; HTTP API will keep running with readiness guard."
    )


if __name__ == "__main__":
    log_startup_config()
    bot_thread = threading.Thread(target=run_bot, name="disbot-thread", daemon=True)
    logger.info("Starting background bot thread | name=%s", bot_thread.name)
    bot_thread.start()

    # The HTTP API can start while the bot is connecting. /orders/notify will guard on readiness.
    wait_for_bot_boot(timeout_seconds=2)
    logger.info("Starting Flask server | host=0.0.0.0 port=%s", DISBOT_PORT)
    app.run(host="0.0.0.0", port=DISBOT_PORT)
