#!/bin/sh
# 在 VMware 里跑一个实验镜像，把串口日志打出来
# 用法: sh tools/lab.sh <iso路径> [等待秒数]
ISO="$1"
WAIT="${2:-9}"
LUMEN="/c/Users/Administrator/WorkBuddy/2026-10-27-19-47-46/lumen"
VMRUN="/c/Program Files (x86)/VMware/VMware Workstation/vmrun.exe"
cp "$ISO" "$LUMEN/dist/lab.iso"
rm -f "$LUMEN/vmware/lab/serial.log"
"$VMRUN" -T ws start "$LUMEN/vmware/lab/lab.vmx" nogui >/dev/null 2>&1
sleep "$WAIT"
"$VMRUN" -T ws stop "$LUMEN/vmware/lab/lab.vmx" hard >/dev/null 2>&1
sleep 1
cat "$LUMEN/vmware/lab/serial.log" 2>/dev/null | tr -d '\000'
