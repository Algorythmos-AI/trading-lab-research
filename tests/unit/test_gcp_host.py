"""The GCP free-tier host (docs/runbooks/gcp-host.md): its first boot and the file secrets source, pinned by test."""
from __future__ import annotations

import os
import re
import stat
import subprocess
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
GCP = ROOT / "deploy" / "gcp"
BIN = ROOT / "deploy" / "oci" / "bin"


def cloud_init() -> dict:
    text = (GCP / "cloud-init.yaml").read_text()
    assert text.startswith("#cloud-config\n")
    return yaml.safe_load(text)


def commands() -> list[str]:
    return [" ".join(c) if isinstance(c, list) else c for c in cloud_init()["runcmd"]]


def test_first_boot_uses_the_file_source_and_no_cloud_cli():
    files = {f["path"]: f["content"] for f in cloud_init()["write_files"]}
    assert files["/etc/wt/secrets-source"].strip() == "file"
    cmds = commands()
    assert not any("oci-cli" in c or "gcloud" in c for c in cmds)      # no cloud credentials or CLIs on the host
    assert any("uv/0.11.7" in c for c in cmds)
    assert any("--require-hashes requirements.lock.txt" in c for c in cmds)
    assert any("--uid-owner wt" in c and "169.254.169.254" in c for c in cmds)
    assert any("apt-mark hold cloudflared" in c for c in cmds)
    assert not any(re.search(r"wt-(routine|paper-b|forward)", c) for c in cmds)   # the owner enables jobs


def test_first_boot_hardening_matches_the_oci_host():
    files = {f["path"]: f["content"] for f in cloud_init()["write_files"]}
    assert "server 169.254.169.254" in files["/etc/chrony/sources.d/gce.sources"]
    assert "zram-size = ram" in files["/etc/systemd/zram-generator.conf"]      # 1 GB RAM: swap in RAM, never disk
    assert "override_rc" in files["/etc/needrestart/conf.d/wt.conf"]
    assert '"${distro_id}:${distro_codename}-security"' in files["/etc/apt/apt.conf.d/52wt-unattended"]
    assert "Sat 16:00 UTC" in files["/etc/systemd/system/apt-daily-upgrade.timer.d/saturday.conf"]
    assert "SystemMaxUse" in files["/etc/systemd/journald.conf.d/wt.conf"]


def test_first_boot_installs_only_files_that_exist():
    cmds = commands()
    assert any("deploy/oci/bin/*" in c for c in cmds) and any("deploy/oci/systemd/*" in c for c in cmds)
    ssh_dir = next(i for i, c in enumerate(cmds) if "install -d -m 0700 /home/wt/.ssh" in c)
    keygen = next(i for i, c in enumerate(cmds) if "ssh-keygen" in c)
    assert ssh_dir < keygen
    for name in ("wt-fetch-secrets", "wt-set-secrets"):
        assert (BIN / name).stat().st_mode & stat.S_IXUSR, name


def test_the_runbook_keeps_the_vm_free_and_closed():
    book = (ROOT / "docs/runbooks/gcp-host.md").read_text()
    for flag in ("--machine-type e2-micro", "--boot-disk-type pd-standard", "--boot-disk-size 30GB",
                 "--zone us-east1-b", "--no-service-account --no-scopes", "--source-ranges 35.235.240.0/20",
                 "--deletion-protection", "user-data=wt-cloud-init.yaml"):
        assert flag in book, flag


def run_fetch(tmp_path: Path, secrets: str) -> subprocess.CompletedProcess[str]:
    """wt-fetch-secrets' file branch, with its root-owned paths moved into tmp_path (no root needed)."""
    etc, run = tmp_path / "etc", tmp_path / "run"
    etc.mkdir(exist_ok=True)
    (etc / "secrets-source").write_text("file\n")
    (etc / "secrets.env").write_text(secrets)
    script = (BIN / "wt-fetch-secrets").read_text()
    script = (re.sub(r"/etc/wt(?=[/\s])", str(etc), script)
                    .replace("/run/wt-secrets", str(run))
                    .replace("install -d -m 0750 -o root -g wt", "mkdir -p")
                    .replace("chown wt:wt", "true").replace("chown root:wt", "true"))
    fake = tmp_path / "wt-fetch-secrets"
    fake.write_text(script)
    return subprocess.run(["bash", str(fake)], capture_output=True, text=True, env={"PATH": os.environ["PATH"]})


REQUIRED = ("APCA_API_KEY_ID=k\nAPCA_API_SECRET_KEY=s=with=equals\nDASHBOARD_INGEST_URL=https://x.invalid/api/ingest\n"
            "DASHBOARD_INGEST_SECRET=d\nVERCEL_AUTOMATION_BYPASS_SECRET=b\nNTFY_TOPIC=t\n")


def test_file_source_writes_the_env_and_paging_files_without_printing_values(tmp_path):
    r = run_fetch(tmp_path, REQUIRED + "WT_ROLE=shadow\nDASHBOARD_KEY_ID=gcp-use1\nUNRELATED=x\n")
    assert r.returncode == 0, r.stderr
    env = (tmp_path / "run" / "env").read_text()
    assert "APCA_API_SECRET_KEY=s=with=equals\n" in env                    # values may contain '='
    assert "WT_ROLE=shadow\n" in env and "DASHBOARD_KEY_ID=gcp-use1\n" in env
    assert "UNRELATED" not in env                                          # only names the host reads
    assert (tmp_path / "etc" / "paging").read_text() == "NTFY_TOPIC=t\n"
    assert "s=with=equals" not in r.stdout + r.stderr and "values written" in r.stdout


def test_file_source_fails_closed_on_a_missing_required_value(tmp_path):
    r = run_fetch(tmp_path, REQUIRED.replace("NTFY_TOPIC=t\n", ""))
    assert r.returncode == 1 and "NTFY_TOPIC" in r.stderr
    assert not (tmp_path / "run" / "env").exists()


def test_the_prompt_script_hides_secrets_and_writes_root_only():
    text = (BIN / "wt-set-secrets").read_text()
    fields = dict(re.findall(r'"([A-Z_0-9]+)\|[^|]*\|([01])\|[01]"', text))
    for name in ("DASHBOARD_INGEST_SECRET", "VERCEL_AUTOMATION_BYPASS_SECRET", "APCA_API_KEY_ID",
                 "APCA_API_SECRET_KEY", "NTFY_TOPIC", "RESTIC_PASSWORD", "CLOUDFLARED_TOKEN"):
        assert fields[name] == "1", f"{name} must be typed hidden"
    assert "read -rsp" in text and "umask 077" in text and "chmod 0600" in text
    fetch = (BIN / "wt-fetch-secrets").read_text()
    wanted = set(re.findall(r"\b[A-Z][A-Z_0-9]+\b(?!=)", fetch.split("REQUIRED=(")[1].split("OCI=")[0]))
    assert wanted == set(fields), "wt-set-secrets must prompt for exactly the names wt-fetch-secrets reads"
