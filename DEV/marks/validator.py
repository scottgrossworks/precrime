import re
from datetime import datetime

class ValidationError(Exception):
    pass

class Validator:
    def __init__(self, raw_data):
        self.data = raw_data
        self.cleaned = {}
        self._validate_and_clean()

    def _validate_and_clean(self):
        name = self._clean_text(self.data.get("name"))
        email = self._clean_text(self.data.get("email"))
        if not name or not email or "@" not in email:
            raise ValidationError("Missing or malformed name/email.")

        self.cleaned["name"] = name
        self.cleaned["email"] = email
        self.cleaned["linkedin"] = self._clean_text(self.data.get("linkedin", ""))
        self.cleaned["on_x"] = self._clean_text(self.data.get("on_x", ""))
        self.cleaned["last_contact"] = self.data.get("last_contact")
        self.cleaned["notes"] = self._clean_text(self.data.get("notes", ""), limit=500)
        self.cleaned["org"] = self._clean_text(self.data.get("org", ""), limit=200)
        self.cleaned["source_text"] = self._clean_text(self.data.get("source_text", ""), limit=300)
        self.cleaned["created_at"] = self.data.get("created_at") or datetime.utcnow().isoformat()

    def _clean_text(self, text, limit=None):
        if not text:
            return ""
        text = text.strip().replace("\n", " ").replace("\r", " ")
        text = re.sub(r"\s+", " ", text)
        text = re.sub(r"[^a-zA-Z0-9 @._\-]", "", text)
        return text[:limit].strip() if limit else text.strip()

    def get(self, field):
        return self.cleaned.get(field)

    def to_dict(self):
        return self.cleaned
