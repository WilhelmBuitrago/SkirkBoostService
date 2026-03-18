import asyncio
import concurrent.futures
import contextlib
import hmac
import json
import logging
import math
import os
import random
import signal
import threading
import time
from datetime import datetime, timezone
from uuid import uuid4

import discord
import redis
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
REDIS_URL = os.getenv("REDIS_URL", "").strip()


# New queue model with legacy fallbacks.
LEGACY_QUEUE_NAME = os.getenv("QUEUE_NAME", "disbot:orders:notify").strip()
MAIN_QUEUE = os.getenv("MAIN_QUEUE", LEGACY_QUEUE_NAME).strip()
PROCESSING_QUEUE = os.getenv("PROCESSING_QUEUE", f"{MAIN_QUEUE}:processing").strip()
RETRY_QUEUE = os.getenv("RETRY_QUEUE", f"{MAIN_QUEUE}:retry").strip()
FAILED_QUEUE = os.getenv("FAILED_QUEUE", f"{MAIN_QUEUE}:failed").strip()

TASK_STORE_PREFIX = os.getenv("TASK_STORE_PREFIX", "disbot:task").strip()
PROCESSED_PREFIX = os.getenv("PROCESSED_PREFIX", "processed").strip()
PROCESSING_LOCK_PREFIX = os.getenv("PROCESSING_LOCK_PREFIX", "processing-lock").strip()
FAILED_RETENTION_INDEX = os.getenv(
    "FAILED_RETENTION_INDEX", f"{FAILED_QUEUE}:ts"
).strip()

DM_TASK_TIMEOUT_SEC = max(3, int(os.getenv("DM_TASK_TIMEOUT_SEC", "12") or "12"))
MAX_RETRIES = max(
    0,
    int(os.getenv("MAX_RETRIES", os.getenv("DM_MAX_RETRIES", "2") or "2") or "2"),
)
RETRY_BACKOFF_BASE = max(
    1,
    int(
        os.getenv(
            "RETRY_BACKOFF_BASE",
            os.getenv("DM_RETRY_BACKOFF_SEC", "60") or "60",
        )
        or "60"
    ),
)
RETRY_BACKOFF_MAX_SEC = max(
    RETRY_BACKOFF_BASE,
    int(os.getenv("RETRY_BACKOFF_MAX_SEC", "900") or "900"),
)
RETRY_JITTER_PCT = min(
    1.0, max(0.0, float(os.getenv("RETRY_JITTER_PCT", "0.20") or "0.20"))
)
WORKER_COUNT = max(1, int(os.getenv("WORKER_COUNT", "2") or "2"))
RETRY_POLL_INTERVAL_SEC = max(1, int(os.getenv("RETRY_POLL_INTERVAL_SEC", "2") or "2"))
ABANDONED_TASK_SEC = max(
    DM_TASK_TIMEOUT_SEC * 3,
    int(os.getenv("ABANDONED_TASK_SEC", str(DM_TASK_TIMEOUT_SEC * 6)) or "72"),
)
PROCESSING_LOCK_TTL_SEC = max(
    DM_TASK_TIMEOUT_SEC + 5,
    int(
        os.getenv(
            "PROCESSING_LOCK_TTL_SEC",
            str(max(DM_TASK_TIMEOUT_SEC + 20, DM_TASK_TIMEOUT_SEC * 2)),
        )
        or str(DM_TASK_TIMEOUT_SEC + 20)
    ),
)
PROCESSED_TTL_SEC = max(0, int(os.getenv("PROCESSED_TTL_SEC", "2592000") or "2592000"))
FAILED_RETENTION_DAYS = max(0, int(os.getenv("FAILED_RETENTION_DAYS", "30") or "30"))
MAINTENANCE_INTERVAL_SEC = max(
    5, int(os.getenv("MAINTENANCE_INTERVAL_SEC", "30") or "30")
)
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
    "redisConnected": False,
    "workersAlive": {},
    "schedulerAlive": False,
    "maintenanceAlive": False,
    "discordThreadAlive": False,
    "lastReadyAt": None,
    "lastDisconnectAt": None,
    "lastConnectionAttemptAt": None,
    "lastDiscordError": None,
    "lastRedisError": None,
    "startupAt": datetime.now(timezone.utc).isoformat(),
    "loginAttemptCount": 0,
}

discord_loop_lock = threading.Lock()
discord_loop: asyncio.AbstractEventLoop | None = None

redis_client: redis.Redis | None = None
discord_thread: threading.Thread | None = None
scheduler_thread: threading.Thread | None = None
maintenance_thread: threading.Thread | None = None
worker_threads: list[threading.Thread] = []


def utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def epoch_now() -> int:
    return int(time.time())


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


def _set_worker_alive(worker_id: int, alive: bool) -> None:
    with state_lock:
        workers = dict(runtime_state.get("workersAlive", {}))
        workers[str(worker_id)] = alive
        runtime_state["workersAlive"] = workers


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


def _task_key(job_id: str) -> str:
    return f"{TASK_STORE_PREFIX}:{job_id}"


def _processed_key(order_id: str) -> str:
    return f"{PROCESSED_PREFIX}:{order_id}"


def _processing_lock_key(order_id: str) -> str:
    return f"{PROCESSING_LOCK_PREFIX}:{order_id}"


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


def _backoff_seconds(attempt: int) -> int:
    base = RETRY_BACKOFF_BASE * (2 ** max(0, attempt - 1))
    bounded = min(base, RETRY_BACKOFF_MAX_SEC)
    jitter = int(max(1, math.ceil(bounded * RETRY_JITTER_PCT)))
    return max(1, bounded + random.randint(-jitter, jitter))


def _is_config_valid() -> bool:
    min_required = DM_TASK_TIMEOUT_SEC + 5
    if PROCESSING_LOCK_TTL_SEC <= DM_TASK_TIMEOUT_SEC:
        logger.error(
            "config_invalid PROCESSING_LOCK_TTL_SEC must be greater than DM_TASK_TIMEOUT_SEC lockTtl=%s timeout=%s",
            PROCESSING_LOCK_TTL_SEC,
            DM_TASK_TIMEOUT_SEC,
        )
        return False
    if ABANDONED_TASK_SEC < min_required:
        logger.error(
            "config_invalid ABANDONED_TASK_SEC too low abandoned=%s minRequired=%s",
            ABANDONED_TASK_SEC,
            min_required,
        )
        return False
    return True


def log_startup_config() -> None:
    logger.info(
        "startup_config pid=%s token=%s userId=%s port=%s sharedSecret=%s redisUrlSet=%s mainQueue=%s processingQueue=%s retryQueue=%s failedQueue=%s workers=%s timeoutSec=%s maxRetries=%s backoffBase=%s jitterPct=%s lockTtl=%s abandonedSec=%s",
        os.getpid(),
        _token_hint(DISCORD_BOT_TOKEN),
        USER_ID,
        DISBOT_PORT,
        "set" if API_SHARED_SECRET else "empty",
        "yes" if REDIS_URL else "no",
        MAIN_QUEUE,
        PROCESSING_QUEUE,
        RETRY_QUEUE,
        FAILED_QUEUE,
        WORKER_COUNT,
        DM_TASK_TIMEOUT_SEC,
        MAX_RETRIES,
        RETRY_BACKOFF_BASE,
        RETRY_JITTER_PCT,
        PROCESSING_LOCK_TTL_SEC,
        ABANDONED_TASK_SEC,
    )

    logger.warning(
        "delivery_semantics mode=at-least-once duplicateDMPossibleOnExtremeFailure=true"
    )

    if not API_SHARED_SECRET:
        logger.warning(
            "startup_warning API_SHARED_SECRET is empty, authorization bypass enabled"
        )


def init_redis_client() -> None:
    global redis_client
    redis_client = redis.Redis.from_url(
        REDIS_URL,
        decode_responses=True,
        socket_connect_timeout=3,
        socket_timeout=3,
    )
    try:
        redis_client.ping()
        _set_state(redisConnected=True, lastRedisError=None)
        logger.info("redis_connected mainQueue=%s", MAIN_QUEUE)
    except redis.RedisError as error:
        _set_state(redisConnected=False, lastRedisError=_safe_error_message(error))
        logger.exception("redis_ping_failed")


def _queue_depth(queue_name: str) -> int | None:
    if redis_client is None:
        return None
    try:
        depth = redis_client.llen(queue_name)
        _set_state(redisConnected=True, lastRedisError=None)
        return int(depth)
    except redis.RedisError as error:
        _set_state(redisConnected=False, lastRedisError=_safe_error_message(error))
        logger.warning("redis_llen_failed queue=%s", queue_name)
        return None


def _zset_depth(key: str) -> int | None:
    if redis_client is None:
        return None
    try:
        count = redis_client.zcard(key)
        _set_state(redisConnected=True, lastRedisError=None)
        return int(count)
    except redis.RedisError as error:
        _set_state(redisConnected=False, lastRedisError=_safe_error_message(error))
        logger.warning("redis_zcard_failed key=%s", key)
        return None


def _load_task(job_id: str) -> dict | None:
    if redis_client is None:
        return None
    raw = redis_client.get(_task_key(job_id))
    if not raw:
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return None


def _save_task(task: dict) -> None:
    if redis_client is None:
        raise RuntimeError("Redis client is not initialized.")
    redis_client.set(_task_key(task["jobId"]), json.dumps(task, ensure_ascii=True))


def _delete_task(job_id: str) -> None:
    if redis_client is None:
        return
    redis_client.delete(_task_key(job_id))


def _mark_processed(order_id: str) -> None:
    if redis_client is None:
        raise RuntimeError("Redis client is not initialized.")
    key = _processed_key(order_id)
    if PROCESSED_TTL_SEC > 0:
        redis_client.setex(key, PROCESSED_TTL_SEC, "true")
    else:
        redis_client.set(key, "true")


def _is_processed(order_id: str) -> bool:
    if redis_client is None:
        return False
    return bool(redis_client.exists(_processed_key(order_id)))


def _acquire_order_lock(order_id: str, job_id: str) -> bool:
    if redis_client is None:
        return False
    key = _processing_lock_key(order_id)
    return bool(redis_client.set(key, job_id, nx=True, ex=PROCESSING_LOCK_TTL_SEC))


def _release_order_lock(order_id: str, job_id: str) -> None:
    if redis_client is None:
        return
    key = _processing_lock_key(order_id)
    with contextlib.suppress(redis.RedisError):
        current = redis_client.get(key)
        if current == job_id:
            redis_client.delete(key)


def _remove_processing_ref(job_id: str) -> None:
    if redis_client is None:
        return
    with contextlib.suppress(redis.RedisError):
        redis_client.lrem(PROCESSING_QUEUE, 1, job_id)


def _push_failed(job_id: str, task: dict) -> None:
    if redis_client is None:
        return
    now = epoch_now()
    redis_client.rpush(FAILED_QUEUE, job_id)
    redis_client.zadd(FAILED_RETENTION_INDEX, {job_id: now})
    _save_task(task)


def _schedule_retry(job_id: str, task: dict) -> None:
    if redis_client is None:
        return
    retry_at = int(task.get("retryAtEpoch", epoch_now()))
    _save_task(task)
    redis_client.zadd(RETRY_QUEUE, {job_id: retry_at})


def _enqueue_notification_task(payload: dict) -> tuple[dict | None, str | None]:
    if redis_client is None:
        return None, "Redis client is not initialized."

    order_id = _sanitize_text(payload.get("orderId"), default="N/A", max_len=64)
    task = {
        "jobId": str(uuid4()),
        "orderId": order_id,
        "queuedAt": utcnow_iso(),
        "queuedAtEpoch": epoch_now(),
        "attempt": 0,
        "status": "queued",
        "lastError": None,
        "processingStartedAt": None,
        "processingStartedAtEpoch": None,
        "finishedAt": None,
        "retryAt": None,
        "retryAtEpoch": None,
        "workerId": None,
        "payload": payload,
    }

    try:
        _save_task(task)
        redis_client.rpush(MAIN_QUEUE, task["jobId"])
        _set_state(redisConnected=True, lastRedisError=None)
        logger.info(
            "task_enqueued state=enqueued jobId=%s orderId=%s attempt=%s ts=%s",
            task["jobId"],
            task["orderId"],
            task["attempt"],
            task["queuedAt"],
        )
        return task, None
    except redis.RedisError as error:
        _set_state(redisConnected=False, lastRedisError=_safe_error_message(error))
        logger.exception("queue_enqueue_failed orderId=%s", order_id)
        return None, "Redis enqueue failed."


def _classify_error(error: Exception) -> tuple[bool, str]:
    if isinstance(error, (concurrent.futures.TimeoutError, TimeoutError)):
        return True, "timeout"
    if isinstance(error, redis.RedisError):
        return True, "redis-transient"
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


def _process_job(worker_id: int, job_id: str) -> None:
    if redis_client is None:
        return

    task = _load_task(job_id)
    if task is None:
        logger.error("task_missing_in_store state=fail jobId=%s", job_id)
        _remove_processing_ref(job_id)
        return

    payload = task.get("payload") or {}
    order_id = _sanitize_text(
        task.get("orderId") or payload.get("orderId"), default="N/A", max_len=64
    )
    attempt = int(task.get("attempt", 0) or 0)

    lock_acquired = False
    try:
        lock_acquired = _acquire_order_lock(order_id, job_id)
        if not lock_acquired:
            raise RuntimeError("Lock busy for order processing.")

        if _is_processed(order_id):
            task["status"] = "idempotent_skip"
            task["finishedAt"] = utcnow_iso()
            _save_task(task)
            logger.info(
                "task_success state=idempotent_skip jobId=%s orderId=%s attempt=%s ts=%s",
                job_id,
                order_id,
                attempt,
                task["finishedAt"],
            )
            _remove_processing_ref(job_id)
            _delete_task(job_id)
            return

        task["status"] = "started"
        task["processingStartedAt"] = utcnow_iso()
        task["processingStartedAtEpoch"] = epoch_now()
        task["workerId"] = worker_id
        _save_task(task)
        logger.info(
            "task_started state=start jobId=%s orderId=%s attempt=%s ts=%s",
            job_id,
            order_id,
            attempt,
            task["processingStartedAt"],
        )

        result = _dispatch_dm(payload)
        _mark_processed(order_id)

        task["status"] = "success"
        task["finishedAt"] = utcnow_iso()
        task["messageId"] = result.get("messageId")
        _save_task(task)
        logger.info(
            "task_success state=success jobId=%s orderId=%s attempt=%s messageId=%s ts=%s",
            job_id,
            order_id,
            attempt,
            task.get("messageId", "N/A"),
            task["finishedAt"],
        )
        _remove_processing_ref(job_id)
        _delete_task(job_id)
    except Exception as error:
        retryable, reason = _classify_error(error)
        next_attempt = attempt + 1
        task["lastError"] = _safe_error_message(error)
        task["errorClass"] = reason
        task["attempt"] = next_attempt
        task["workerId"] = worker_id

        _remove_processing_ref(job_id)

        if retryable and next_attempt <= MAX_RETRIES:
            delay_sec = _backoff_seconds(next_attempt)
            retry_epoch = epoch_now() + delay_sec
            task["status"] = "retry_scheduled"
            task["retryAtEpoch"] = retry_epoch
            task["retryAt"] = datetime.fromtimestamp(
                retry_epoch, tz=timezone.utc
            ).isoformat()
            _schedule_retry(job_id, task)
            logger.warning(
                "task_retry_scheduled state=retry jobId=%s orderId=%s attempt=%s reason=%s retryAt=%s",
                job_id,
                order_id,
                next_attempt,
                reason,
                task["retryAt"],
            )
        else:
            task["status"] = "failed_final"
            task["finishedAt"] = utcnow_iso()
            _push_failed(job_id, task)
            logger.error(
                "task_failed_final state=fail jobId=%s orderId=%s attempt=%s retryable=%s reason=%s error=%s ts=%s",
                job_id,
                order_id,
                next_attempt,
                retryable,
                reason,
                task["lastError"],
                task["finishedAt"],
            )
    finally:
        if lock_acquired:
            _release_order_lock(order_id, job_id)


def run_notification_worker(worker_id: int) -> None:
    _set_worker_alive(worker_id, True)
    logger.info(
        "worker_thread_started workerId=%s mainQueue=%s processingQueue=%s",
        worker_id,
        MAIN_QUEUE,
        PROCESSING_QUEUE,
    )
    try:
        while not shutdown_event.is_set():
            if redis_client is None:
                _set_state(redisConnected=False, lastRedisError="Redis not initialized")
                continue

            try:
                job_id = redis_client.brpoplpush(
                    MAIN_QUEUE,
                    PROCESSING_QUEUE,
                    timeout=2,
                )
                _set_state(redisConnected=True, lastRedisError=None)
            except redis.RedisError as error:
                _set_state(
                    redisConnected=False,
                    lastRedisError=_safe_error_message(error),
                )
                logger.exception("worker_pop_failed workerId=%s", worker_id)
                continue

            if not job_id:
                continue

            _process_job(worker_id, job_id)
    finally:
        _set_worker_alive(worker_id, False)
        logger.info("worker_thread_stopped workerId=%s", worker_id)


def run_retry_scheduler() -> None:
    _set_state(schedulerAlive=True)
    logger.info("retry_scheduler_started queue=%s", RETRY_QUEUE)
    try:
        while not shutdown_event.is_set():
            if redis_client is None:
                shutdown_event.wait(RETRY_POLL_INTERVAL_SEC)
                continue

            try:
                now = epoch_now()
                due_job_ids = redis_client.zrangebyscore(
                    RETRY_QUEUE,
                    min=0,
                    max=now,
                    start=0,
                    num=100,
                )
                _set_state(redisConnected=True, lastRedisError=None)
            except redis.RedisError as error:
                _set_state(
                    redisConnected=False,
                    lastRedisError=_safe_error_message(error),
                )
                logger.exception("retry_scheduler_query_failed")
                shutdown_event.wait(RETRY_POLL_INTERVAL_SEC)
                continue

            for job_id in due_job_ids:
                if shutdown_event.is_set():
                    break

                try:
                    removed = redis_client.zrem(RETRY_QUEUE, job_id)
                    if removed:
                        task = _load_task(job_id)
                        if task is None:
                            continue
                        task["status"] = "retry_requeued"
                        task["queuedAt"] = utcnow_iso()
                        task["queuedAtEpoch"] = epoch_now()
                        _save_task(task)
                        redis_client.rpush(MAIN_QUEUE, job_id)
                        logger.info(
                            "retry_requeued state=requeued jobId=%s orderId=%s attempt=%s ts=%s",
                            job_id,
                            _sanitize_text(
                                task.get("orderId"), default="N/A", max_len=64
                            ),
                            task.get("attempt", 0),
                            task.get("queuedAt"),
                        )
                except redis.RedisError as error:
                    _set_state(
                        redisConnected=False,
                        lastRedisError=_safe_error_message(error),
                    )
                    logger.exception("retry_requeue_failed jobId=%s", job_id)

            shutdown_event.wait(RETRY_POLL_INTERVAL_SEC)
    finally:
        _set_state(schedulerAlive=False)
        logger.info("retry_scheduler_stopped")


def _recover_abandoned_processing() -> None:
    if redis_client is None:
        return

    now = epoch_now()
    try:
        processing_refs = redis_client.lrange(PROCESSING_QUEUE, 0, 500)
        _set_state(redisConnected=True, lastRedisError=None)
    except redis.RedisError as error:
        _set_state(redisConnected=False, lastRedisError=_safe_error_message(error))
        logger.exception("recovery_processing_scan_failed")
        return

    for job_id in processing_refs:
        if shutdown_event.is_set():
            return

        try:
            task = _load_task(job_id)
            if task is None:
                _remove_processing_ref(job_id)
                continue

            started_epoch = int(task.get("processingStartedAtEpoch") or 0)
            if started_epoch <= 0:
                continue

            age = now - started_epoch
            if age < ABANDONED_TASK_SEC:
                continue

            removed = redis_client.lrem(PROCESSING_QUEUE, 1, job_id)
            if removed:
                task["status"] = "recovered_from_processing"
                task["recoveredAt"] = utcnow_iso()
                task["queuedAt"] = utcnow_iso()
                task["queuedAtEpoch"] = epoch_now()
                _save_task(task)
                redis_client.rpush(MAIN_QUEUE, job_id)
                logger.warning(
                    "task_recovered state=recovered jobId=%s orderId=%s ageSec=%s thresholdSec=%s",
                    job_id,
                    _sanitize_text(task.get("orderId"), default="N/A", max_len=64),
                    age,
                    ABANDONED_TASK_SEC,
                )
        except redis.RedisError as error:
            _set_state(redisConnected=False, lastRedisError=_safe_error_message(error))
            logger.exception("recovery_job_failed jobId=%s", job_id)


def _cleanup_failed_retention() -> None:
    if redis_client is None or FAILED_RETENTION_DAYS <= 0:
        return

    cutoff = epoch_now() - (FAILED_RETENTION_DAYS * 24 * 60 * 60)
    try:
        expired = redis_client.zrangebyscore(FAILED_RETENTION_INDEX, min=0, max=cutoff)
    except redis.RedisError as error:
        _set_state(redisConnected=False, lastRedisError=_safe_error_message(error))
        logger.exception("failed_retention_query_failed")
        return

    if not expired:
        return

    for job_id in expired:
        try:
            removed = redis_client.zrem(FAILED_RETENTION_INDEX, job_id)
            if removed:
                redis_client.lrem(FAILED_QUEUE, 1, job_id)
                _delete_task(job_id)
                logger.info(
                    "failed_retention_purged state=cleanup jobId=%s retentionDays=%s",
                    job_id,
                    FAILED_RETENTION_DAYS,
                )
        except redis.RedisError as error:
            _set_state(redisConnected=False, lastRedisError=_safe_error_message(error))
            logger.exception("failed_retention_purge_failed jobId=%s", job_id)


def run_maintenance_loop() -> None:
    _set_state(maintenanceAlive=True)
    logger.info("maintenance_loop_started intervalSec=%s", MAINTENANCE_INTERVAL_SEC)
    try:
        while not shutdown_event.is_set():
            _recover_abandoned_processing()
            _cleanup_failed_retention()
            shutdown_event.wait(MAINTENANCE_INTERVAL_SEC)
    finally:
        _set_state(maintenanceAlive=False)
        logger.info("maintenance_loop_stopped")


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

    for thread in worker_threads:
        if thread.is_alive():
            thread.join(timeout=8)
    if scheduler_thread is not None and scheduler_thread.is_alive():
        scheduler_thread.join(timeout=8)
    if maintenance_thread is not None and maintenance_thread.is_alive():
        maintenance_thread.join(timeout=8)
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
        return f"Missing payload fields: {', '.join(missing)}", None

    services = payload.get("services")
    if not isinstance(services, list) or len(services) < 1:
        return "services must be a non-empty list.", None
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

    workers_alive = snapshot.get("workersAlive", {})
    response = {
        "ok": not shutdown_event.is_set(),
        "service": "disbot",
        "botReady": bot_ready_event.is_set(),
        "gatewayConnected": snapshot.get("gatewayConnected", False),
        "loopRunning": loop_running,
        "redisConnected": snapshot.get("redisConnected", False),
        "queueDepth": _queue_depth(MAIN_QUEUE),
        "processingDepth": _queue_depth(PROCESSING_QUEUE),
        "retryDepth": _zset_depth(RETRY_QUEUE),
        "failedDepth": _queue_depth(FAILED_QUEUE),
        "workersConfigured": WORKER_COUNT,
        "workersActive": sum(1 for alive in workers_alive.values() if alive),
        "workersAlive": workers_alive,
        "schedulerAlive": snapshot.get("schedulerAlive", False),
        "maintenanceAlive": snapshot.get("maintenanceAlive", False),
        "discordThreadAlive": snapshot.get("discordThreadAlive", False),
        "lastReadyAt": snapshot.get("lastReadyAt"),
        "lastDisconnectAt": snapshot.get("lastDisconnectAt"),
        "lastConnectionAttemptAt": snapshot.get("lastConnectionAttemptAt"),
        "lastDiscordError": snapshot.get("lastDiscordError"),
        "lastRedisError": snapshot.get("lastRedisError"),
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
        return jsonify({"accepted": False, "error": "Unauthorized."}), 401

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
        return jsonify({"accepted": False, "error": validation_error}), 400

    task, queue_error = _enqueue_notification_task(sanitized_payload)
    if queue_error:
        logger.error(
            "http_enqueue_failed requestId=%s orderId=%s error=%s",
            request_id,
            sanitized_payload.get("orderId", "N/A"),
            queue_error,
        )
        return (
            jsonify(
                {
                    "accepted": False,
                    "error": "Notification queue unavailable.",
                }
            ),
            503,
        )

    logger.info(
        "http_enqueue_success requestId=%s orderId=%s jobId=%s",
        request_id,
        sanitized_payload.get("orderId", "N/A"),
        task.get("jobId", "N/A"),
    )
    return (
        jsonify(
            {
                "accepted": True,
                "enqueued": True,
                "jobId": task.get("jobId"),
                "queuedAt": task.get("queuedAt"),
            }
        ),
        202,
    )


if __name__ == "__main__":
    log_startup_config()
    if not _is_config_valid():
        raise SystemExit(2)

    _install_signal_handlers()
    init_redis_client()

    # One startup recovery pass before workers start consuming.
    _recover_abandoned_processing()

    discord_thread = threading.Thread(
        target=run_discord_runtime,
        name="discord-runtime-thread",
        daemon=False,
    )

    scheduler_thread = threading.Thread(
        target=run_retry_scheduler,
        name="retry-scheduler-thread",
        daemon=False,
    )

    maintenance_thread = threading.Thread(
        target=run_maintenance_loop,
        name="maintenance-thread",
        daemon=False,
    )

    for worker_id in range(1, WORKER_COUNT + 1):
        thread = threading.Thread(
            target=run_notification_worker,
            args=(worker_id,),
            name=f"notification-worker-thread-{worker_id}",
            daemon=False,
        )
        worker_threads.append(thread)

    logger.info("thread_start name=%s", discord_thread.name)
    discord_thread.start()

    logger.info("thread_start name=%s", scheduler_thread.name)
    scheduler_thread.start()

    logger.info("thread_start name=%s", maintenance_thread.name)
    maintenance_thread.start()

    for thread in worker_threads:
        logger.info("thread_start name=%s", thread.name)
        thread.start()

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
