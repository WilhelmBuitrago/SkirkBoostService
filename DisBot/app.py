import asyncio
import concurrent.futures
import os
import threading
import time
from datetime import datetime, timezone

import discord
from dotenv import load_dotenv
from flask import Flask, jsonify, request

load_dotenv()

DISCORD_BOT_TOKEN = os.getenv("DISCORD_BOT_TOKEN", "").strip()
USER_ID = int(os.getenv("USER_ID", "0") or "0")
DISBOT_PORT = int(os.getenv("DISBOT_PORT", "5000") or "5000")
API_SHARED_SECRET = os.getenv("API_SHARED_SECRET", "").strip()

app = Flask(__name__)

intents = discord.Intents.none()
client = discord.Client(intents=intents)

bot_ready_event = threading.Event()


@client.event
async def on_ready():
    print(f"DisBot connected as {client.user}")
    bot_ready_event.set()


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
        user = await client.fetch_user(USER_ID)

    sent_message = await user.send(message)

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
        return True

    incoming_secret = (req.headers.get("x-api-shared-secret") or "").strip()
    return incoming_secret == API_SHARED_SECRET


@app.get("/health")
def health():
    return jsonify(
        {
            "ok": True,
            "service": "disbot",
            "botReady": bot_ready_event.is_set(),
        }
    )


@app.get("/")
def root_health():
    return jsonify(
        {
            "ok": True,
            "service": "disbot",
            "botReady": bot_ready_event.is_set(),
        }
    )


@app.post("/orders/notify")
def notify_order():
    if not is_authorized(request):
        return jsonify({"accepted": False, "error": "Unauthorized."}), 401

    if not bot_ready_event.is_set():
        return jsonify({"accepted": False, "error": "Bot is not ready yet."}), 503

    payload = request.get_json(silent=True) or {}
    validation_error = validate_payload(payload)
    if validation_error:
        return jsonify({"accepted": False, "error": validation_error}), 400

    try:
        future = asyncio.run_coroutine_threadsafe(send_order_dm(payload), client.loop)
        result = future.result(timeout=12)
        return jsonify(result), 200
    except concurrent.futures.TimeoutError:
        return jsonify({"accepted": False, "error": "Discord DM timeout."}), 504
    except Exception as error:
        return jsonify({"accepted": False, "error": f"Discord DM failed: {error}"}), 502


def run_bot():
    if not DISCORD_BOT_TOKEN:
        raise RuntimeError("DISCORD_BOT_TOKEN is required.")
    if USER_ID <= 0:
        raise RuntimeError("USER_ID is required and must be > 0.")
    client.run(DISCORD_BOT_TOKEN)


def wait_for_bot_boot(timeout_seconds: int = 30) -> None:
    start = time.time()
    while time.time() - start < timeout_seconds:
        if bot_ready_event.is_set():
            return
        time.sleep(0.25)


if __name__ == "__main__":
    bot_thread = threading.Thread(target=run_bot, name="disbot-thread", daemon=True)
    bot_thread.start()

    # The HTTP API can start while the bot is connecting. /orders/notify will guard on readiness.
    wait_for_bot_boot(timeout_seconds=2)
    app.run(host="0.0.0.0", port=DISBOT_PORT)
