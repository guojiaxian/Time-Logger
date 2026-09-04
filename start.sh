#!/bin/bash
# 时间记录器 - 启动服务器
# 用法: ./start.sh [PORT]

set -e
cd "$(dirname "$0")"

PORT="${1:-8443}"
PID_FILE="server.pid"
LOG_FILE="server.log"

# 已在运行则退出
if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "[错误] 服务器已在运行, PID=$(cat "$PID_FILE")"
  echo "如需重启请先执行: ./stop.sh"
  exit 1
fi

# 清理残留 pid 文件
rm -f "$PID_FILE"

echo "启动时间记录器服务器, 端口: $PORT"
echo "日志: $(pwd)/$LOG_FILE"

PORT="$PORT" nohup node server.js > "$LOG_FILE" 2>&1 &
echo $! > "$PID_FILE"

# 等待 2 秒检查是否启动成功
sleep 2
if kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "启动成功 (PID=$(cat "$PID_FILE"))"
  echo "HTTPS: https://localhost:$PORT"
  echo "停止:  ./stop.sh"
else
  echo "[失败] 服务器未能启动, 查看日志: tail -30 $LOG_FILE"
  rm -f "$PID_FILE"
  exit 1
fi