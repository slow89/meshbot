#!/bin/bash
# UserPromptSubmit hook for meshbot
# Reads pending messages from the queue file and injects them as context
# so Claude sees incoming messages on every user interaction.
#
# Env vars (set by meshbot start):
#   MESHBOT_QUEUE_FILE — path to the queue.json file

if [ -z "$MESHBOT_QUEUE_FILE" ]; then
  exit 0
fi

if [ ! -f "$MESHBOT_QUEUE_FILE" ]; then
  exit 0
fi

# Read the queue file
QUEUE=$(cat "$MESHBOT_QUEUE_FILE" 2>/dev/null)

# Check if it's empty or just "[]"
if [ -z "$QUEUE" ] || [ "$QUEUE" = "[]" ]; then
  exit 0
fi

# Count messages
COUNT=$(echo "$QUEUE" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null)

if [ -z "$COUNT" ] || [ "$COUNT" = "0" ]; then
  exit 0
fi

# Output context that Claude will see
echo "[MESH INBOX] You have $COUNT pending message(s) from other agents. Call check_messages to read them."

exit 0
