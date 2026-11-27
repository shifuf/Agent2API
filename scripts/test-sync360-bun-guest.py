import argparse
import gzip
import hashlib
import os
import re
import shutil
import stat
import subprocess
import tempfile
import zipfile
from pathlib import Path


def add_entry(output, name, mode, data=b''):
    path = name.encode('ascii') + b'\0'
    values = (1, mode, 0, 0, 1, 0, len(data), 0, 0, 0, 0, len(path), 0)
    header = b'070701' + ''.join(f'{value:08x}' for value in values).encode('ascii') + path
    output.write(header + bytes(-len(header) % 4))
    output.write(data)
    output.write(bytes(-len(data) % 4))


def dynamic_libraries(binary):
    env = {'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'}
    result = subprocess.run(['ldd', str(binary)], capture_output=True, check=True, text=True, env=env)
    return {Path(path) for path in re.findall(r'(/[^\s]+)\s+\(0x', result.stdout)}


def main():
    parser = argparse.ArgumentParser(description='Run the fixed Bun fixture inside a disposable amd64 Linux guest; no disks, host mounts or network.')
    parser.add_argument('--qemu', type=Path, required=True)
    parser.add_argument('--kernel', type=Path, required=True)
    parser.add_argument('--bun-zip', type=Path, required=True)
    parser.add_argument('--firmware-dir', type=Path)
    parser.add_argument('--bios', type=Path)
    args = parser.parse_args()
    if os.getuid() == 0:
        raise SystemExit('Run the emulator as a non-root local test user.')
    if hashlib.sha256(args.bun_zip.read_bytes()).hexdigest() != 'c678040f14fe0440eb839d37cbd0ce4c051a32da72806ac97de6a6aab6bf728f':
        raise SystemExit('Bun archive does not match the reviewed Linux x64 baseline release.')
    fixture = Path(__file__).parent / 'fixtures/bun-guest-provider.mjs'
    with tempfile.TemporaryDirectory(prefix='a2api-bun-guest-') as directory:
        work = Path(directory)
        bun = work / 'bun'
        with zipfile.ZipFile(args.bun_zip) as archive, archive.open('bun-linux-x64-baseline/bun') as source, bun.open('wb') as target:
            shutil.copyfileobj(source, target)
        bun.chmod(0o555)
        setpriv = Path('/usr/bin/setpriv')
        libraries = dynamic_libraries(bun) | dynamic_libraries(setpriv)
        files = {str(lib).lstrip('/'): (0o555, lib.read_bytes()) for lib in libraries}
        init = b'''#!/bin/sh
/bin/busybox mount -t proc proc /proc || exit 1
/bin/busybox mount -t devtmpfs devtmpfs /dev || exit 1
/bin/busybox mount -t tmpfs -o size=8m,mode=1777 tmpfs /tmp || exit 1
if /bin/busybox env -i HOME=/tmp TMPDIR=/tmp PATH=/bin DO_NOT_TRACK=1 /bin/setpriv --reuid=65534 --regid=65534 --clear-groups --no-new-privs /bin/bun /probe.mjs; then echo A2API_BUN_GUEST_OK; else echo A2API_BUN_GUEST_FAILED; fi
/bin/busybox poweroff -f
'''
        files.update({'bin/bun': (0o555, bun.read_bytes()), 'bin/setpriv': (0o555, setpriv.read_bytes()),
                      'bin/busybox': (0o555, Path('/bin/busybox').read_bytes()), 'init': (0o555, init),
                      'gateway/private': (0o400, b'synthetic gateway sentinel'), 'other-plugin/private': (0o400, b'synthetic peer sentinel'),
                      'plugin/index.mjs': (0o444, fixture.read_bytes()), 'probe.mjs': (0o444, b"import provider from './plugin/index.mjs'; if ((await provider.server()).auth.provider !== 'fixture-offline') throw new Error('invalid hooks')")})
        folders = {'tmp', 'dev', 'proc'} | {str(parent) for path in files for parent in Path(path).parents if str(parent) != '.'}
        image = work / 'guest.cpio.gz'
        with gzip.open(image, 'wb', compresslevel=1) as output:
            for folder in sorted(folders):
                add_entry(output, folder, stat.S_IFDIR | 0o755)
            for name, (mode, data) in files.items():
                add_entry(output, name, stat.S_IFREG | mode, data)
            add_entry(output, 'bin/sh', stat.S_IFLNK | 0o777, b'busybox')
            add_entry(output, 'TRAILER!!!', 0)
        command = [str(args.qemu), '-machine', 'pc,accel=tcg', '-cpu', 'max', '-m', '768', '-smp', '1', '-nodefaults', '-no-reboot', '-nographic', '-serial', 'stdio', '-monitor', 'none', '-nic', 'none', '-kernel', str(args.kernel), '-initrd', str(image), '-append', 'console=ttyS0 quiet panic=1 rdinit=/init']
        if args.firmware_dir: command.extend(['-L', str(args.firmware_dir)])
        if args.bios: command.extend(['-bios', str(args.bios)])
        result = subprocess.run(command, capture_output=True, stdin=subprocess.DEVNULL, timeout=120)
        if result.returncode or b'A2API_BUN_GUEST_OK' not in result.stdout:
            raise SystemExit((result.stdout + result.stderr)[-3000:].decode(errors='replace'))
        print('PASS pinned Bun 1.4.2 in disposable Linux guest: OpenCode server hook, denied gateway/peer reads, read-only package and no network')


if __name__ == '__main__':
    main()
