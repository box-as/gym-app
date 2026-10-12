#!/usr/bin/env python3
"""Print a RepState PBKDF2 password verifier; the password is never echoed or saved."""
import base64
import getpass
import hashlib
import secrets

password = getpass.getpass("New RepState sync password: ")
confirm = getpass.getpass("Confirm password: ")
if password != confirm:
    raise SystemExit("Passwords do not match.")
if len(password) < 14:
    raise SystemExit("Use at least 14 characters.")
salt = secrets.token_bytes(16)
digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, 310_000, dklen=32)
print(base64.urlsafe_b64encode(salt + digest).decode("ascii").rstrip("="))
