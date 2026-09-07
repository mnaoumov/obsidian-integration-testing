#!/usr/bin/env bash
#
# Creates the AVD the Android jobs boot, provisioned to the minimums the Android
# guide documents.
#
# Those four settings are minimums, not suggestions: Android Studio's (and
# avdmanager's) defaults produce a device that fails in ways that look like
# plugin bugs. `disk.dataPartition.size` is the one that actually bites — every
# failed run leaks a registered temp vault, and a full /data presents as a
# WebView-readiness timeout rather than as a full disk. See the "AVD
# provisioning" section of docs/src/content/docs/guides/android.md, which this
# script is the CI half of.
#
# Shared by both jobs of validate-android-emulator.yml so the emulator the probe
# measures and the emulator the suite runs against are provisioned identically —
# a probe on a differently-sized device would prove nothing about the suite's.
#
# Usage: bash .github/scripts/create-avd.sh <avd-name> <system-image-package>

set -euo pipefail

AVD_NAME="$1"
SYSTEM_IMAGE="$2"
CONFIG_PATH="$HOME/.android/avd/$AVD_NAME.avd/config.ini"

yes | sdkmanager --licenses > /dev/null
sdkmanager --install "$SYSTEM_IMAGE" emulator platform-tools

# `echo no` declines the "custom hardware profile?" prompt; --force replaces any
# AVD of the same name rather than failing a re-run.
echo no | avdmanager create avd --force --name "$AVD_NAME" --package "$SYSTEM_IMAGE"

# Rewrite rather than append: avdmanager has already written its own value for
# most of these, and a duplicated key leaves which one wins up to the parser.
for KEY in disk.dataPartition.size hw.cpu.ncore hw.ramSize vm.heapSize; do
  sed -i "/^${KEY}=/d" "$CONFIG_PATH"
done

cat >> "$CONFIG_PATH" << 'EOF'
disk.dataPartition.size=16G
hw.cpu.ncore=4
hw.ramSize=4096
vm.heapSize=512
EOF

echo "Provisioned $AVD_NAME:"
cat "$CONFIG_PATH"
