"""`make keys-check` (wt.ops.keys_check): names and verdicts only, never a value, offline, always exit 0."""
from __future__ import annotations

import ast
import hashlib
from pathlib import Path

import pytest

from wt.ops import keys_check as kc

ID, SECRET = "PKFAKEID0000000001", "fakeSecretValue/abc+123"
OLD_ID, OLD_SECRET = "PKFAKEOLD000000002", "olderFakeSecret/xyz=9"
EVERY_VALUE = (ID, SECRET, OLD_ID, OLD_SECRET, "PKFAKEOPT000000003", "optFakeSecret")


def _env_file(tmp_path: Path, body: str, name: str = ".env") -> Path:
    p = tmp_path / name
    p.write_bytes(body.encode())
    return p


def _run(capsys: pytest.CaptureFixture[str], tmp_path: Path, environ: dict[str, str], argv: list[str] | None = None) -> str:
    assert kc.main(argv or [], environ=environ, root=tmp_path) == 0
    return capsys.readouterr().out


def _no_values(out: str) -> None:
    for v in EVERY_VALUE:
        assert v not in out
        for part in (v[:6], v[-6:]):
            assert part not in out
        assert hashlib.sha256(v.encode()).hexdigest()[:8] not in out


def test_shell_pair_differs_from_the_file(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    # `export ` prefixes, double and single quotes, CRLF line ends: read as load_dotenv reads them.
    _env_file(tmp_path, f'export APCA_API_KEY_ID="{ID}"\r\nexport APCA_API_SECRET_KEY=\'{SECRET}\'\r\n# note\r\n')
    out = _run(capsys, tmp_path, {"APCA_API_KEY_ID": OLD_ID, "APCA_API_SECRET_KEY": OLD_SECRET})
    assert "the shell's pair differs from .env's: Python tools will use the shell's" in out
    _no_values(out)


def test_same_pair_with_crlf_and_quotes(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    _env_file(tmp_path, f'APCA_API_KEY_ID="{ID}"\r\nAPCA_API_SECRET_KEY={SECRET}\r\n')
    out = _run(capsys, tmp_path, {"APCA_API_KEY_ID": ID, "APCA_API_SECRET_KEY": SECRET})
    assert "the shell's pair is the same as .env's" in out
    _no_values(out)


def test_only_the_file_defines_it(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    _env_file(tmp_path, "APCA_OPTIONS_KEY_ID=PKFAKEOPT000000003\nAPCA_OPTIONS_SECRET_KEY=optFakeSecret\n")
    out = _run(capsys, tmp_path, {})
    assert "the shell sets neither name: Python tools use .env's pair" in out
    assert "not set anywhere" in out                          # the clone pair, for one
    _no_values(out)


def test_mixed_and_empty(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    _env_file(tmp_path, f"APCA_API_SECRET_KEY={SECRET}\nAPCA_CLONE_KEY_ID={ID}\n")
    out = _run(capsys, tmp_path, {"APCA_API_KEY_ID": OLD_ID, "APCA_OPTIONS_KEY_ID": "", "APCA_OPTIONS_SECRET_KEY": ""})
    assert "the shell sets only APCA_API_KEY_ID: Python tools mix it with APCA_API_SECRET_KEY from .env, a mixed pair" in out
    assert "an empty name in the shell still wins over every file" in out
    assert ".env defines only part of the pair: the pair is incomplete" in out
    _no_values(out)


def test_no_file_and_the_host_file(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    host = _env_file(tmp_path, f"APCA_API_KEY_ID={OLD_ID}\nAPCA_API_SECRET_KEY={OLD_SECRET}\n", "secrets.env")
    out = _run(capsys, tmp_path, {"WT_ENV_FILE": str(host)})
    assert ".env: " in out and "(not found)" in out
    assert "the shell sets neither name: Python tools use WT_ENV_FILE's pair" in out
    _no_values(out)
    other = _env_file(tmp_path, f"APCA_API_KEY_ID={ID}\nAPCA_API_SECRET_KEY={SECRET}\n", "other.env")
    out = _run(capsys, tmp_path, {"WT_ENV_FILE": str(host)}, ["--env-file", str(other)])
    assert "WT_ENV_FILE's pair differs from .env's; .env's wins (loaded first)" in out
    _no_values(out)


def test_the_dashboard_names(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    out = _run(capsys, tmp_path, {"ALPACA_API_KEY_ID": ID, "ALPACA_API_SECRET_KEY": SECRET})
    assert "no Python tool reads these names" in out
    _no_values(out)


def test_offline_and_never_loads_the_config() -> None:
    """No network library, and no wt import: wt.core.config would load .env into the environment it inspects."""
    tree = ast.parse(Path(kc.__file__).read_text())
    mods = {a.name for n in ast.walk(tree) if isinstance(n, ast.Import) for a in n.names}
    mods |= {n.module or "" for n in ast.walk(tree) if isinstance(n, ast.ImportFrom)}
    assert not any(m.split(".")[0] in {"wt", "requests", "urllib", "http", "socket", "alpaca"} for m in mods)
