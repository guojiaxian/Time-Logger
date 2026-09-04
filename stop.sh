#!/bin/bash
# 时间记录器 - 停止服务器
# 用法: ./stop.sh

cd "$(dirname "$0")"
PID_FILE="server.pid"

if [ ! -f "$PID_FILE" ]; then
  # 尝试通过进程名查找
  PID=$(pgrep -f "node server.js" 2>/dev/null || true)
  if [ -n "$PID" ]; then
    echo "发现运行中的服务器进程 (PID=$PID), 正在停止…"
    kill "$PID" 2>/dev/null
    sleep 1
    if kill -0 "$PID" 2>/dev/null; then
      echo "等待进程退出…"
      sleep 2
      kill -9 "$PID" 2>/dev/null || true
    fi
    echo "已停止."
  else
    echo "没有运行中的服务器."
  fi
  exit 0
fi

PID=$(cat "$PID_FILE")
if [ -z "$PID" ]; then
  echo "PID 文件为空, 请检查."
  rm -f "$PID_FILE"
  exit 1
fi

if kill -0 "$PID" 2>/dev/null; then
  echo "正在停止服务器 (PID=$PID)…"
  kill "$PID" 2>/dev/null
  sleep 1
  if kill -0 "$PID" 2>/dev/null; then
    echo "进程未响应, 强制终止…"
    sleep 2
    kill -9 "$PID" 2>/dev/null || true
  fi
  echo "已停止."
else
  echo "进程早已退出 (PID=$PID)."
fi

rm -f "$PID_FILE"