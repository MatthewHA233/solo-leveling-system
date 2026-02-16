"""
独自升级系统 - 服务端入口
python -m server.core
"""
import asyncio
from .system import main

if __name__ == "__main__":
    asyncio.run(main())
