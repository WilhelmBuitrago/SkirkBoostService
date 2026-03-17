import asyncio
import contextlib
import logging
import os
import time
from datetime import datetime, timedelta, timezone

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


def _as_float(value) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _extract_retry_after_seconds(headers) -> float:
    retry_after = _as_float(headers.get("Retry-After"))
    if retry_after is not None:
        return max(0.1, retry_after)

    reset_after = _as_float(headers.get("X-RateLimit-Reset-After"))
    if reset_after is not None:
        return max(0.1, reset_after)

    reset_epoch = _as_float(headers.get("X-RateLimit-Reset"))
    if reset_epoch is not None:
        return max(0.1, reset_epoch - time.time())

    # Fallback conservador cuando Discord no devuelve cabeceras completas.
    return 30.0


def _format_remaining(seconds: float) -> str:
    total_seconds = int(seconds)
    minutes, rem_seconds = divmod(total_seconds, 60)
    if minutes > 0:
        return f"{minutes} min {rem_seconds} s"
    return f"{seconds:.1f} s"


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

    try:
        await client.start(DISCORD_BOT_TOKEN)
    except discord.HTTPException as exc:
        if exc.status != 429:
            raise

        headers = getattr(exc.response, "headers", {}) if exc.response else {}
        retry_after_seconds = _extract_retry_after_seconds(headers)
        unblock_eta = datetime.now(timezone.utc) + timedelta(
            seconds=retry_after_seconds
        )

        is_global = str(headers.get("X-RateLimit-Global", "")).lower() == "true"
        scope = headers.get("X-RateLimit-Scope", "unknown")

        logger.error(
            "Discord 429 detectado | status=%s scope=%s global=%s bucket=%s limit=%s remaining=%s",
            exc.status,
            scope,
            is_global,
            headers.get("X-RateLimit-Bucket", "N/A"),
            headers.get("X-RateLimit-Limit", "N/A"),
            headers.get("X-RateLimit-Remaining", "N/A"),
        )
        logger.error(
            "Tiempo estimado para desban: %s (%.2f s) | ETA UTC: %s",
            _format_remaining(retry_after_seconds),
            retry_after_seconds,
            unblock_eta.isoformat(),
        )
    finally:
        with contextlib.suppress(Exception):
            await client.close()


if __name__ == "__main__":
    asyncio.run(main())
