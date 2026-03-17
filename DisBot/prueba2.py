import asyncio
import logging
import os
import threading

import discord
from dotenv import load_dotenv
from flask import Flask, jsonify

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("disbot-prueba2")

DISCORD_BOT_TOKEN = os.getenv("DISCORD_BOT_TOKEN", "").strip()
USER_ID = int(os.getenv("USER_ID", "0") or "0")
DISBOT_PORT = int(os.getenv("DISBOT_PORT", "5000") or "5000")

app = Flask(__name__)

intents = discord.Intents.none()
client = discord.Client(intents=intents)
bot_ready_event = threading.Event()
dm_task_scheduled = False


@client.event
async def on_ready():
    global dm_task_scheduled
    logger.info(
        "Bot conectado | user=%s user_id=%s",
        client.user,
        getattr(client.user, "id", "N/A"),
    )
    bot_ready_event.set()

    if not dm_task_scheduled:
        dm_task_scheduled = True
        client.loop.create_task(send_hola_after_30_seconds())


async def send_hola_after_30_seconds():
    if USER_ID <= 0:
        logger.error("USER_ID invalido: %s", USER_ID)
        await client.close()
        return

    logger.info("Esperando 30 segundos antes de enviar DM...")
    await asyncio.sleep(30)

    try:
        user = client.get_user(USER_ID)
        if user is None:
            logger.info("Usuario no esta en cache, consultando API...")
            user = await client.fetch_user(USER_ID)

        logger.info("Enviando DM a USER_ID=%s", USER_ID)
        sent = await user.send("Hola")
        logger.info("DM enviado correctamente | message_id=%s", sent.id)
    except Exception:
        logger.exception("Fallo enviando DM en prueba2")
    finally:
        logger.info("Cerrando cliente Discord. Flask seguira activo.")
        await client.close()


def run_discord_bot():
    if not DISCORD_BOT_TOKEN:
        raise RuntimeError("DISCORD_BOT_TOKEN es requerido.")
    if USER_ID <= 0:
        raise RuntimeError("USER_ID es requerido y debe ser > 0.")

    logger.info("Iniciando cliente Discord en hilo paralelo...")
    client.run(DISCORD_BOT_TOKEN)


@app.get("/")
def root():
    return jsonify(
        {
            "ok": True,
            "service": "disbot-prueba2",
            "botReady": bot_ready_event.is_set(),
        }
    )


@app.get("/health")
def health():
    return jsonify(
        {
            "ok": True,
            "service": "disbot-prueba2",
            "botReady": bot_ready_event.is_set(),
        }
    )


if __name__ == "__main__":
    bot_thread = threading.Thread(
        target=run_discord_bot,
        name="discord-prueba2-thread",
        daemon=True,
    )
    bot_thread.start()

    logger.info("Levantando Flask en 0.0.0.0:%s", DISBOT_PORT)
    app.run(host="0.0.0.0", port=DISBOT_PORT)
