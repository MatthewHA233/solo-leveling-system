"""
独自升级系统 - 模块入口
python -m src.core.system
"""
import asyncio
from .system import main

if __name__ == "__main__":
    asyncio.run(main())
