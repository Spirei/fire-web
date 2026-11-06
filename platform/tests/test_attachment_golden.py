import json
import re
from pathlib import Path

import pytest
from alcor_api.admin_attachment_api import mime
from alcor_api.admin_attachments import filename, relpath
from fastapi import HTTPException

GOLDEN = json.loads(Path(__file__).with_name("attachment-golden.json").read_text())


@pytest.mark.parametrize("case", GOLDEN["names"])
def test_names_from_actual_old_typescript_function(case):
    actual = filename(case["input"])
    if case["expected"].startswith("file-"):
        assert re.fullmatch("file-[0-9]+", actual)
    else:
        assert actual == case["expected"]


@pytest.mark.parametrize("case", GOLDEN["paths"])
def test_virtual_paths_keep_old_valid_normalization_and_traversal_rejection(case):
    if case.get("error"):
        with pytest.raises(HTTPException):
            relpath(case["input"])
    else:
        assert relpath(case["input"]) == case["expected"]


@pytest.mark.parametrize("case", GOLDEN["mime"])
def test_preview_mime_from_actual_old_function(case):
    assert mime(case["input"]) == case["expected"]
