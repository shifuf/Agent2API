import argparse
import gzip
import hashlib
import importlib.util
import os
import re
import selectors
import stat
import subprocess
import tempfile
import time
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description='Boot an offline real Linux acceptance host, then use its actual gateway HTTP API to start a separate TCG diagnostic guest.')
    for name in ['kit', 'server', 'bun']:
        parser.add_argument('--' + name, type=Path, required=True)
    parser.add_argument('--limits', action='store_true', help='Check the wall watchdog and independent kernel CPU quota on the actual QEMU process')
    parser.add_argument('--controls-only', action='store_true', help='Verify HTTP authorization, limits, process cancellation and refusal only')
    parser.add_argument('--budget', type=int, choices=range(30, 301), metavar='30..300', help='Set the Linux gateway operator wall-time budget for this test only')
    parser.add_argument('--invalid-budget', choices=['301', 'unlimited'], help='Set an invalid operator budget and assert the real endpoint is unavailable')
    args = parser.parse_args()
    if os.getuid() == 0:
        raise SystemExit('Run this test as a non-root user.')
    kit = args.kit.resolve()
    qemu = kit / 'qemu-system-x86_64'
    scripts = Path(__file__).resolve().parent
    spec = importlib.util.spec_from_file_location('image_tools', scripts / 'test-sync360-bun-guest.py')
    tools = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(tools)
    env = {'PATH': '/usr/bin:/bin', 'LD_LIBRARY_PATH': str(kit), 'QEMU_MODULE_DIR': str(kit), 'LC_ALL': 'C'}
    files = {}
    for binary in [args.server.resolve(), qemu, args.bun.resolve(), Path('/usr/bin/setpriv')]:
        output = subprocess.run(['ldd', str(binary)], env=env, check=True, text=True, capture_output=True).stdout
        if 'not found' in output:
            raise SystemExit('Missing verified host runtime libraries')
        for item in re.findall(r'(/[^\s]+)\s+\(0x', output):
            lib = Path(item)
            if lib.parent != kit:
                files[item.lstrip('/')] = (0o555, lib)
    for source in kit.iterdir():
        files['kit/' + source.name] = (0o555 if source == qemu else 0o444, source)
    if (kit / 'accel-tcg-x86_64.so').exists():
        files['usr/lib/x86_64-linux-gnu/qemu/accel-tcg-x86_64.so'] = (0o444, kit / 'accel-tcg-x86_64.so')
    files.update({'bin/busybox': (0o555, Path('/bin/busybox')), 'bin/bun': (0o555, args.bun),
                  'bin/setpriv': (0o555, Path('/usr/bin/setpriv')), 'bin/gateway': (0o555, args.server),
                  'app/test.mjs': (0o444, scripts / 'test-sync360-community-probe.mjs'),
                  'app/fixtures/panel-session.mjs': (0o444, scripts / 'fixtures/panel-session.mjs'),
                  'app/fixtures/bun-guest-provider.mjs': (0o444, scripts / 'fixtures/bun-guest-provider.mjs')})
    init = b'''#!/bin/sh
set -eu
/bin/busybox mount -t devtmpfs devtmpfs /dev
/bin/busybox mount -t proc proc /proc
/bin/busybox mount -t sysfs sysfs /sys
/bin/busybox mount -t tmpfs -o size=240m,mode=1777,nosuid,nodev tmpfs /tmp
/bin/busybox ip link set lo up
echo REAL_LINUX_GATEWAY_ACCEPTANCE_STARTED
if /bin/busybox env -i PATH=/bin HOME=/tmp TMPDIR=/tmp AGENT2API_COMMUNITY_GUEST_DIR=/kit /bin/setpriv --reuid=65534 --regid=65534 --clear-groups --no-new-privs /bin/bun /app/test.mjs /bin/gateway --guest; then echo REAL_LINUX_GATEWAY_ACCEPTANCE_PASS; else echo REAL_LINUX_GATEWAY_ACCEPTANCE_FAIL; fi
/bin/busybox poweroff -f
'''
    if args.limits:
        init = init.replace(b'--guest; then', b'--guest --limits; then')
        init = init.replace(b'echo REAL_LINUX_GATEWAY_ACCEPTANCE_STARTED', b'''/bin/busybox mount -t tracefs tracefs /sys/kernel/tracing
echo 'sig == 9 || sig == 24' >/sys/kernel/tracing/events/signal/signal_generate/filter
echo 1 >/sys/kernel/tracing/events/signal/signal_generate/enable
echo REAL_LINUX_GATEWAY_ACCEPTANCE_STARTED''')
        init = init.replace(b'/bin/busybox poweroff -f', b'''echo 0 >/sys/kernel/tracing/events/signal/signal_generate/enable
/bin/busybox grep 'signal_generate:' /sys/kernel/tracing/trace | /bin/busybox tail -30
/bin/busybox poweroff -f''')
    if args.controls_only:
        init = init.replace(b'--guest', b'--guest --controls-only')
    if args.budget is not None and args.invalid_budget:
        parser.error('--budget and --invalid-budget are mutually exclusive')
    if args.budget is not None or args.invalid_budget:
        value = args.invalid_budget or str(args.budget)
        init = init.replace(b'AGENT2API_COMMUNITY_GUEST_DIR=/kit ', b'AGENT2API_COMMUNITY_GUEST_DIR=/kit AGENT2API_COMMUNITY_GUEST_TIMEOUT_SECS=' + value.encode('ascii') + b' ')
    if args.invalid_budget:
        init = init.replace(b'--guest', b'--guest --unavailable')
    folders = {'tmp', 'dev', 'proc', 'sys'} | {str(parent) for name in files for parent in Path(name).parents if str(parent) != '.'}
    with tempfile.TemporaryDirectory(prefix='community-outer-test-') as folder:
        image = Path(folder) / 'host.cpio.gz'
        with gzip.open(image, 'wb', compresslevel=1) as output:
            for name in sorted(folders):
                tools.add_entry(output, name, stat.S_IFDIR | 0o755)
            for name, (mode, source) in files.items():
                content = source.read_bytes()
                if name == 'bin/gateway':
                    print('Real Linux gateway SHA-256:', hashlib.sha256(content).hexdigest(), flush=True)
                tools.add_entry(output, name, stat.S_IFREG | mode, content)
            tools.add_entry(output, 'bin/sh', stat.S_IFLNK | 0o777, b'busybox')
            tools.add_entry(output, 'init', stat.S_IFREG | 0o555, init)
            tools.add_entry(output, 'TRAILER!!!', 0)
        command = [str(qemu), '-machine', 'pc,accel=tcg', '-cpu', 'max', '-m', '2560', '-smp', '2', '-nodefaults', '-no-reboot', '-display', 'none', '-serial', 'stdio', '-monitor', 'none', '-nic', 'none', '-L', str(kit), '-bios', str(kit / 'bios.bin'), '-kernel', str(kit / 'vmlinuz'), '-initrd', str(image), '-append', 'console=ttyS0 quiet loglevel=2 panic=1 rdinit=/init']
        with subprocess.Popen(command, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT) as process:
            output = bytearray()
            deadline = time.monotonic() + (1500 if args.limits else 900)
            try:
                with selectors.DefaultSelector() as poll:
                    poll.register(process.stdout, selectors.EVENT_READ)
                    while time.monotonic() < deadline:
                        if not poll.select(1):
                            continue
                        part = os.read(process.stdout.fileno(), 2048)
                        if not part:
                            break
                        output.extend(part)
                        if len(output) > 16384:
                            raise SystemExit('Acceptance guest output exceeded bound')
                        print(part.decode(errors='replace'), end='', flush=True)
                if b'REAL_LINUX_GATEWAY_ACCEPTANCE_PASS' not in output or process.wait(timeout=15) != 0:
                    raise SystemExit('Nested real Linux gateway acceptance did not pass')
            finally:
                if process.poll() is None:
                    process.kill()
                process.wait()


if __name__ == '__main__':
    main()
