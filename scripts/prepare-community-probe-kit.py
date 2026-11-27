import argparse
import gzip
import hashlib
import importlib.util
import os
import re
import shutil
import stat
import subprocess
import tempfile
import zipfile
from pathlib import Path


def load_image_tools():
    spec = importlib.util.spec_from_file_location('a2api_guest_image', Path(__file__).with_name('test-sync360-bun-guest.py'))
    tools = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(tools)
    return tools


def main():
    parser = argparse.ArgumentParser(description='Build a read-only amd64 TCG probe kit from trusted local Linux distribution artifacts. No guest code or package scripts run here.')
    for name in ['qemu', 'kernel', 'bios', 'firmware-dir', 'bun-zip', 'output']:
        parser.add_argument('--' + name, type=Path, required=True)
    parser.add_argument('--qemu-libs', type=Path, help='Optional reviewed distro library directory for a non-system QEMU installation')
    parser.add_argument('--tcg-module', type=Path, help='The distro accel-tcg-x86_64.so, when TCG is a separate QEMU module')
    args = parser.parse_args()
    if hashlib.sha256(args.bun_zip.read_bytes()).hexdigest() != 'c678040f14fe0440eb839d37cbd0ce4c051a32da72806ac97de6a6aab6bf728f':
        raise SystemExit('Pinned Bun 1.4.2 Linux x64 baseline digest mismatch.')
    if args.output.exists():
        raise SystemExit('Choose a new kit directory; existing kits are not replaced.')
    tools = load_image_tools()
    with tempfile.TemporaryDirectory(prefix='community-kit-build-', dir=args.output.parent) as tmp:
        work = Path(tmp)
        kit = work / 'kit'
        kit.mkdir(mode=0o755)
        for source, target in [(args.qemu, 'qemu-system-x86_64'), (args.kernel, 'vmlinuz'), (args.bios, 'bios.bin')]:
            shutil.copyfile(source, kit / target)
        for name in ['linuxboot.bin', 'linuxboot_dma.bin', 'kvmvapic.bin']:
            shutil.copyfile(args.firmware_dir / name, kit / name)
        if args.tcg_module:
            shutil.copyfile(args.tcg_module, kit / 'accel-tcg-x86_64.so')
        if args.qemu_libs:
            library_dir = args.qemu_libs.resolve()
            env = {'PATH': '/usr/bin:/bin', 'LC_ALL': 'C', 'LD_LIBRARY_PATH': str(library_dir)}
            result = subprocess.run(['ldd', str(args.qemu)], capture_output=True, check=True, text=True, env=env)
            if 'not found' in result.stdout:
                raise SystemExit('QEMU runtime dependencies are incomplete.')
            for soname, target in re.findall(r'^\s*(\S+) => (/[^\s]+) ', result.stdout, re.M):
                source = Path(target)
                if source.parent == library_dir and re.fullmatch(r'lib[\w.+-]+', soname):
                    shutil.copyfile(source, kit / soname)
        bun = work / 'bun'
        with zipfile.ZipFile(args.bun_zip) as archive, archive.open('bun-linux-x64-baseline/bun') as source, bun.open('wb') as target:
            shutil.copyfileobj(source, target)
        bun.chmod(0o555)
        busybox = Path('/bin/busybox')
        setpriv = Path('/usr/bin/setpriv')
        libraries = tools.dynamic_libraries(bun) | tools.dynamic_libraries(setpriv)
        files = {str(lib).lstrip('/'): (0o555, lib.read_bytes()) for lib in libraries}
        guest_init = b'''#!/bin/sh
set -eu
/bin/busybox mount -t proc proc /proc
/bin/busybox mount -t devtmpfs devtmpfs /dev
/bin/busybox mount -t tmpfs -o size=8m,mode=1777,nosuid,nodev tmpfs /tmp
/bin/busybox mount -t tmpfs -o size=64k,mode=0700,nosuid,nodev tmpfs /run
/bin/busybox chmod 600 /dev/console /dev/ttyS0
ulimit -c 0
if /bin/busybox env -i HOME=/tmp TMPDIR=/tmp PATH=/bin DO_NOT_TRACK=1 /bin/setpriv --reuid=65534 --regid=65534 --clear-groups --no-new-privs /bin/bun /probe.mjs </dev/null >/dev/null 2>/dev/null 3>/run/result && [ "$(/bin/busybox wc -c </run/result)" -eq 1 ] && [ "$(/bin/busybox cat /run/result)" = Y ]; then echo A2API_DIAGNOSTIC_HOOK_COMPLETED; fi
/bin/busybox poweroff -f
'''
        driver = b'''import {writeSync} from 'node:fs';
if(process.getuid()!==65534 || Bun.version!=='1.4.2') throw Error();
const provider=(await import('/plugin/index.mjs')).default;
if(typeof provider?.server!=='function') throw Error();
const hooks=await provider.server();
if(!hooks || typeof hooks!=='object' || Array.isArray(hooks)) throw Error();
writeSync(3,'Y');
'''
        files.update({'bin/bun': (0o555, bun.read_bytes()), 'bin/setpriv': (0o555, setpriv.read_bytes()),
                      'bin/busybox': (0o555, busybox.read_bytes()), 'init': (0o555, guest_init), 'probe.mjs': (0o444, driver),
                      'gateway/private': (0o400, b'diagnostic gateway sentinel'), 'other-plugin/private': (0o400, b'diagnostic peer sentinel')})
        folders = {'tmp', 'run', 'dev', 'proc', 'plugin'} | {str(parent) for name in files for parent in Path(name).parents if str(parent) != '.'}
        with gzip.open(kit / 'runtime.cpio.gz', 'wb', compresslevel=1) as image:
            for folder in sorted(folders):
                tools.add_entry(image, folder, stat.S_IFDIR | 0o755)
            for name, (mode, data) in files.items():
                tools.add_entry(image, name, stat.S_IFREG | mode, data)
            tools.add_entry(image, 'bin/sh', stat.S_IFLNK | 0o777, b'busybox')
            tools.add_entry(image, 'TRAILER!!!', 0)
        for file in kit.iterdir():
            file.chmod(0o555 if file.name == 'qemu-system-x86_64' else 0o444)
        kit.chmod(0o555)
        os.rename(kit, args.output)
    print('Kit ready. Run the gateway unprivileged, with AGENT2API_COMMUNITY_GUEST_DIR pointing at a root-owned read-only kit.')


if __name__ == '__main__':
    main()
