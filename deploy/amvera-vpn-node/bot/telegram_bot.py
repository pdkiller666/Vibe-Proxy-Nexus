"""Minimal Telegram bot for checking node status. Client issuance is owned by
the Vibe Proxy Nexus web app, not this bot — this only reports node health so
an admin can sanity-check the node from Telegram.
"""
import asyncio
import os

from aiogram import Bot, Dispatcher
from aiogram.filters import CommandStart, Command
from aiogram.types import Message

import xray_manager

BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
ADMIN_CHAT_ID = os.environ.get("TELEGRAM_ADMIN_CHAT_ID", "")

dp = Dispatcher()


def _is_authorized(message: Message) -> bool:
    if not ADMIN_CHAT_ID:
        return True
    return str(message.chat.id) == str(ADMIN_CHAT_ID)


@dp.message(CommandStart())
async def start(message: Message) -> None:
    if not _is_authorized(message):
        return
    await message.answer(
        "Vibe Proxy Nexus — узел активен.\nКоманды: /status"
    )


@dp.message(Command("status"))
async def status(message: Message) -> None:
    if not _is_authorized(message):
        return
    try:
        clients = xray_manager.list_clients()
        await message.answer(f"Узел работает.\nАктивных клиентов: {len(clients)}")
    except Exception as exc:  # noqa: BLE001
        await message.answer(f"Ошибка чтения конфигурации: {exc}")


async def main() -> None:
    if not BOT_TOKEN:
        print("TELEGRAM_BOT_TOKEN not set — status bot disabled.")
        return
    bot = Bot(token=BOT_TOKEN)
    await dp.start_polling(bot)


if __name__ == "__main__":
    asyncio.run(main())
