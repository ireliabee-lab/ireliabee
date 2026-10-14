"""API preview/confirmation and paid screenshot isolation, entirely mocked."""
from backend.tests import _env  # noqa: F401

import io
from unittest import mock

from fastapi.testclient import TestClient
from PIL import Image

from backend.main import app
from backend.core import local_guard, hosted, providers
from backend.routers import links

client = TestClient(app, base_url="http://127.0.0.1:8000", headers={"x-irb-token": local_guard.TOKEN})


def image_bytes():
    out = io.BytesIO()
    Image.new('RGB', (30, 30), 'white').save(out, format='PNG')
    return out.getvalue()


def price():
    return mock.patch.object(hosted, 'rates', return_value={'creditsPerUsd': 2, 'perMillionTokensUsd': {'vision': {'in': 3, 'out': 15}, 'fast': {'in': 0.1, 'out': 0.2}}})


def test_preview_does_not_save_until_explicit_save():
    with mock.patch.object(links.link_import, 'preview', return_value={'text': 'Visible content', 'url': 'https://example.com', 'title': 'Article'}) as fetch, mock.patch.object(links.link_import, 'save_source') as save:
        out = client.post('/links/preview', json={'url': 'https://example.com'})
    assert out.status_code == 200
    assert out.json()['text'] == 'Visible content'
    fetch.assert_called_once_with('https://example.com')
    save.assert_not_called()


def test_explicit_save_returns_document_and_source():
    out = client.post('/links/save', json={'url': 'https://example.com', 'title': 'Article', 'text': 'Reviewed text', 'method': 'browser'})
    assert out.status_code == 200
    assert out.json()['source']['method'] == 'browser'


def test_saving_only_the_public_start_of_a_post_says_so_on_the_source():
    out = client.post('/links/save', json={'url': 'https://x.com/ada/status/1', 'title': 'Post by Ada', 'text': 'The start', 'partial': True})
    assert out.status_code == 200
    assert out.json()['source']['partial'] is True
    whole = client.post('/links/save', json={'url': 'https://x.com/ada/status/2', 'title': 'Post by Ada', 'text': 'All of it'})
    assert 'partial' not in whole.json()['source']


def test_screenshot_estimate_uses_vision_rates_and_no_ai():
    with mock.patch.object(hosted, 'access_token', return_value='fixture'), price(), mock.patch.object(providers, 'respond_with_image') as vision:
        out = client.get('/links/screenshot/estimate')
    assert out.status_code == 200
    assert out.json()['credits'] == 0.219
    vision.assert_not_called()


def test_unknown_price_does_not_send_image():
    with mock.patch.object(hosted, 'access_token', return_value='fixture'), mock.patch.object(hosted, 'rates', return_value=None), mock.patch.object(providers, 'respond_with_image') as vision:
        out = client.post('/links/screenshot', data={'url': 'https://example.com', 'confirmed': 'true', 'max_credits': '1'}, files={'file': ('screen.png', image_bytes(), 'image/png')})
    assert out.status_code == 503
    vision.assert_not_called()


def test_missing_cost_confirmation_refuses_vision():
    with mock.patch.object(providers, 'respond_with_image') as vision:
        out = client.post('/links/screenshot', data={'url': 'https://example.com'}, files={'file': ('screen.png', image_bytes(), 'image/png')})
    assert out.status_code == 400
    vision.assert_not_called()


def test_increased_price_requires_new_confirmation():
    with mock.patch.object(hosted, 'access_token', return_value='fixture'), price(), mock.patch.object(providers, 'respond_with_image') as vision:
        out = client.post('/links/screenshot', data={'url': 'https://example.com', 'confirmed': 'true', 'max_credits': '.01'}, files={'file': ('screen.png', image_bytes(), 'image/png')})
    assert out.status_code == 409
    vision.assert_not_called()


def test_confirmed_screenshot_uses_hosted_image_path_only_and_is_not_saved():
    from backend import relay
    with mock.patch.object(hosted, 'access_token', return_value='fixture'), price(), mock.patch.object(providers, 'respond_with_image', return_value='Transcribed text') as vision, mock.patch.object(links.link_import, 'save_source') as save, mock.patch.object(relay, 'enqueue_sync') as relay_call:
        out = client.post('/links/screenshot', data={'url': 'https://example.com', 'confirmed': 'true', 'max_credits': '1'}, files={'file': ('screen.png', image_bytes(), 'image/png')})
    assert out.status_code == 200
    assert out.json()['text'] == 'Transcribed text'
    assert out.json()['method'] == 'screenshot'
    assert vision.call_args.kwargs['hosted_only'] is True
    relay_call.assert_not_called()
    save.assert_not_called()


def test_bad_image_never_reaches_vision():
    with mock.patch.object(hosted, 'access_token', return_value='fixture'), price(), mock.patch.object(providers, 'respond_with_image') as vision:
        out = client.post('/links/screenshot', data={'url': 'https://example.com', 'confirmed': 'true', 'max_credits': '1'}, files={'file': ('screen.png', b'not an image', 'image/png')})
    assert out.status_code == 400
    vision.assert_not_called()


def test_hosted_image_path_ignores_own_keys_and_relay():
    import anthropic
    from backend import relay
    with mock.patch.object(hosted, 'access_token', return_value='service-token'), mock.patch.object(hosted, 'anthropic_base', return_value='https://ireliabee.co.uk'), mock.patch.object(anthropic, 'Anthropic') as sdk, mock.patch.object(providers, '_vision_anthropic', return_value='OCR') as vision, mock.patch.object(providers, '_hosted', side_effect=AssertionError('Must not use own keys')), mock.patch.object(relay, 'enqueue_sync') as relay_call:
        out = providers.respond_with_image('deepseek', 'any', 'fixture.png', 'Read it', hosted_only=True)
    assert out == 'OCR'
    sdk.assert_called_once_with(api_key='service-token', base_url='https://ireliabee.co.uk')
    assert vision.call_args.kwargs['client'] is sdk.return_value
    relay_call.assert_not_called()
