"""Check all custom commands are ACL-enrolled and external capture has one grant."""
from backend.tests import _env  # noqa: F401
from pathlib import Path
import json
import re

ROOT = Path(__file__).resolve().parents[2] / 'frontend' / 'src-tauri'


def test_capture_capability_cannot_read_credentials_or_use_other_commands():
    caps = [json.loads(p.read_text(encoding='utf-8-sig')) for p in (ROOT / 'capabilities').glob('*.json')]
    capture = next(c for c in caps if c['identifier'] == 'link-capture')
    assert capture['windows'] == ['link-capture']
    assert capture['local'] is False
    assert capture['permissions'] == ['allow-capture-link-text']
    assert capture['remote']['urls'] == ['http://*', 'https://*']
    for capability in caps:
        if capability is not capture:
            assert 'link-capture' not in capability.get('windows', [])
            assert '*' not in capability.get('windows', [])
    for denied in ['allow-local-token', 'allow-backend-port', 'allow-relay-bridge-command']:
        assert denied not in capture['permissions']


def test_all_registered_commands_are_declared_through_app_manifest():
    source = (ROOT / 'src' / 'lib.rs').read_text(encoding='utf-8-sig')
    handlers = re.search(r'generate_handler!\[([^\]]+)\]', source).group(1)
    registered = {x.strip().split('::')[-1] for x in handlers.split(',')}
    build = (ROOT / 'build.rs').read_text(encoding='utf-8-sig')
    declared = set(re.findall(r'"([a-z_]+)"', build))
    assert 'AppManifest::new().commands' in build
    assert registered == declared
    main = json.loads((ROOT / 'capabilities' / 'default.json').read_text(encoding='utf-8-sig'))
    reminder = json.loads((ROOT / 'capabilities' / 'reminder.json').read_text(encoding='utf-8-sig'))
    for command in registered - {'capture_link_text'}:
        assert 'allow-' + command.replace('_', '-') in main['permissions']
    assert {'allow-fit-reminder', 'allow-reminder-choice'} <= set(reminder['permissions'])


def test_remote_browser_has_own_storage_and_capture_needs_native_user_action():
    source = (ROOT / 'src' / 'link_browser.rs').read_text(encoding='utf-8-sig')
    script = (ROOT / 'src' / 'capture-visible.js').read_text(encoding='utf-8-sig')
    assert '.data_directory(directory)' in source
    assert '.join("link-browser")' in source
    assert '.on_navigation(navigation_allowed)' in source
    assert 'NewWindowResponse::Deny' in source
    assert 'Click Save to notebook in the browser menu first' in source
    assert '*pending = None' in source
    assert 'window.label() != LABEL' in source
    assert 'emit_to("main", "link-captured"' in source
    assert 'local_token' not in source
    assert 'pairing_key' not in source
    assert 'scrollTo' not in script and 'fetch(' not in script


def test_compiled_manifest_gates_app_commands_with_no_default_grant():
    manifest = json.loads((ROOT / 'gen' / 'schemas' / 'acl-manifests.json').read_text(encoding='utf-8-sig'))['__app-acl__']
    assert manifest['default_permission'] is None
    permission = manifest['permissions']['allow-capture-link-text']
    assert permission['commands']['allow'] == ['capture_link_text']
    assert not set(permission['commands']['allow']) & {'local_token', 'backend_port', 'relay_bridge_command'}
