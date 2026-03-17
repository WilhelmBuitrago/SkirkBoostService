import asyncio
import logging
import os

import discord
from dotenv import load_dotenv

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("disbot-prueba")

DISCORD_BOT_TOKEN = os.getenv("DISCORD_BOT_TOKEN", "").strip()
USER_ID = int(os.getenv("USER_ID", "0") or "0")

intents = discord.Intents.none()
client = discord.Client(intents=intents)


@client.event
async def on_ready():
    logger.info(
        "Bot conectado | user=%s user_id=%s",
        client.user,
        getattr(client.user, "id", "N/A"),
    )

    if USER_ID <= 0:
        logger.error("USER_ID invalido: %s", USER_ID)
        await client.close()
        return

    try:
        user = client.get_user(USER_ID)
        if user is None:
            logger.info("Usuario no esta en cache, consultando API...")
            user = await client.fetch_user(USER_ID)

        logger.info("Enviando DM de prueba a USER_ID=%s", USER_ID)
        sent = await user.send("Hola")
        logger.info("DM enviado correctamente | message_id=%s", sent.id)
    except Exception:
        logger.exception("Fallo enviando DM de prueba")
    finally:
        await client.close()


async def main() -> None:
    if not DISCORD_BOT_TOKEN:
        raise RuntimeError("DISCORD_BOT_TOKEN es requerido.")

    if USER_ID <= 0:
        raise RuntimeError("USER_ID es requerido y debe ser > 0.")

    await client.start(DISCORD_BOT_TOKEN)


if __name__ == "__main__":
    asyncio.run(main())
