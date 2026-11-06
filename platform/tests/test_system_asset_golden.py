import base64
import json
from pathlib import Path

import pytest
from alcor_api.system_asset_codec import asset_name, image_bytes
from fastapi import HTTPException

GOLDEN = json.loads(Path(__file__).with_name("system-assets-golden.json").read_text())


@pytest.mark.parametrize("case", GOLDEN["images"], ids=lambda c: c["name"])
def test_actual_old_image_validator_and_svg_output_bytes(case):
    raw = base64.b64decode(case["input"])
    if not case["valid"]:
        with pytest.raises(HTTPException):
            image_bytes(raw, case["ext"])
    else:
        output, mime = image_bytes(raw, case["ext"])
        assert output == base64.b64decode(case["output"])
        assert mime.startswith("image/")


@pytest.mark.parametrize("case", GOLDEN["names"])
def test_actual_short_ascii_names_keep_original_hash_and_scope_rules(case):
    assert (
        asset_name(case["name"], case["code"], case["market"], case["type"], case["ext"]) == case["expected"]
    )
