#!/usr/bin/env python3
"""Send WikiMasters transaction notices through user-configured SMTP."""

import hashlib
import json
import os
import smtplib
import ssl
import sys
from email.message import EmailMessage
from email.utils import formataddr


def message_for(payload, sender):
    subject = payload.get("subject")
    body = payload.get("body")
    event_key = payload.get("eventKey")
    if not all(isinstance(value, str) and value for value in (subject, body, event_key)):
        raise ValueError("invalid_notification")
    if len(subject) > 160 or len(body) > 4000 or len(event_key) > 100:
        raise ValueError("notification_too_large")
    message = EmailMessage()
    message["From"] = formataddr(("WikiMasters Bot", sender))
    recipient = os.environ.get("WMMA_MAIL_TO")
    if not recipient or "@" not in recipient:
        raise ValueError("mail_recipient_unavailable")
    message["To"] = recipient
    message["Subject"] = subject
    digest = hashlib.sha256(event_key.encode("utf-8")).hexdigest()[:32]
    message["Message-ID"] = f"<wikimasters-{digest}@{sender.rsplit('@', 1)[-1]}>"
    message.set_content(body)
    return message


def main():
    payload = json.load(sys.stdin)
    sender = os.environ.get("WMMA_SMTP_USER")
    password = os.environ.get("WMMA_SMTP_PASSWORD")
    if not sender or not password:
        raise ValueError("smtp_credentials_unavailable")
    message = message_for(payload, sender)
    host = os.environ.get("WMMA_SMTP_HOST", "smtp.gmail.com")
    port = int(os.environ.get("WMMA_SMTP_PORT", "587"))
    with smtplib.SMTP(host, port, timeout=20) as smtp:
        smtp.starttls(context=ssl.create_default_context())
        smtp.login(sender, password)
        smtp.send_message(message)
    print("smtp_accepted")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print("smtp_unavailable", file=sys.stderr)
        sys.exit(1)
