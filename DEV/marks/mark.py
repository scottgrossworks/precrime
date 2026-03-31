from datetime import datetime
import re

from flask import jsonify

from validator import Validator, ValidationError
from db_utils import insert_document, insert_vector, get_mark, createUniqueKey, EMBEDDING_MODEL_ID


MAX_SOURCE_EACH = 300  # Max length for each source text
MAX_SOURCE_TOTAL = 1000


#
# NOT USED
# If emails might include aliases (like jane.doe+xyz@gmail.com)
def canonicalize_email(email):
    local, _, domain = email.partition("@")
    local = local.split("+")[0].replace(".", "")
    return f"{local}@{domain}"






#
# we want source text to be ADDITIVE 
# if a new mark comes on matching an existing mark, add the new source
# AFTER cleaning and trimming
#
def clean_source_text(text, max_chars=MAX_SOURCE_EACH):
    if not text:
        return ""
    text = text.strip().replace("\n", " ").replace("\r", " ")
    text = re.sub(r"\s+", " ", text)  # Collapse whitespace
    return text[:max_chars].strip()




# merge existing mark with new data
# strategy: prefer new data when present, else keep old
#
def merge_marks(existing_doc, new_data):

    existing_data = existing_doc.to_dict()
    
    merged = {}

    # Fields to copy directly or overwrite if new data is present
    fields = ["name", "email", "linkedin", "on_x", "last_contact", "org"]

    for field in fields:
        old_val = existing_data.get(field, "")
        new_val = new_data.get(field, "")
        merged[field] = new_val if new_val else old_val

    # Created_at: preserve original creation date
    merged["created_at"] = existing_data.get("created_at")

    # Outreach count: preserve or initialize
    merged["outreach_count"] = existing_data.get("outreach_count", 0)

    # Embedding source stays constant for now
    merged["embedding_source"] = existing_data.get("embedding_source")

    # Merge notes
    old_notes = existing_data.get("notes", "")
    new_notes = new_data.get("notes", "")
    if old_notes and new_notes and old_notes != new_notes:
        merged["notes"] = f"{old_notes.strip()}\n{new_notes.strip()}"
    elif old_notes:
        merged["notes"] = old_notes
    elif new_notes:
        merged["notes"] = new_notes
    else:
        merged["notes"] = ""

    # Type remains fixed
    merged["type"] = "mark"

    # Clean and merge source text
    old_source = clean_source_text(existing_data.get("source_text", ""))
    new_source = clean_source_text(new_data.get("source_text", ""))

    if old_source and new_source:
        
        if old_source != new_source:  # Only merge if they differ
            merged_text = f"{old_source}\n{new_source}".strip()
        else:
            merged_text = old_source

    elif old_source:
        merged_text = old_source
    elif new_source:
        merged_text = new_source
    else:
        merged_text = ""

    # Final trim and clean
    merged["source_text"] = merged_text[:MAX_SOURCE_EACH]

    return merged






#
#
#
#
def create_mark(request):

    try:
        raw_data = request.get_json(silent=True)
        validator = Validator(raw_data)

    except ValidationError as ve:
        return jsonify({"error": str(ve)}), 400

    mark_name = validator.get("name")
    mark_email = validator.get("email")
    linkedin_url = validator.get("linkedin")
    
    # GET UNIQUE ID
    unique_id = createUniqueKey( mark_name, mark_email, linkedin_url )

    # CHECK FOR EXISTING ENTITY
    existing_doc = get_mark(unique_id)
    
    if existing_doc and existing_doc.exists:
        doc = merge_marks(existing_doc, validator.to_dict())
    
    else:
        doc = {
            "type": "mark",
            "name": mark_name,
            "email": mark_email,
            "linkedin": linkedin_url,
            "on_x": validator.get("on_x"),
            "created_at": validator.get("created_at"),
            "embedding_source": EMBEDDING_MODEL_ID,
            "last_contact": validator.get("last_contact"),
            "notes": validator.get("notes"),
            "org": validator.get("org"),
            "outreach_count": 0
        }



    # source text (optional) enriches the schema in the embedding
    source_text = validator.get("source_text")


    #
    # INSERT INTO VECTOR DB
    #
    embed_result = insert_vector(unique_id, doc, source_text)

    # Record the embedding source only if embedded
    if embed_result.get("status") == "embedded":
        doc["embedding_source"] = EMBEDDING_MODEL_ID

    #
    # INSERT INTO SCHEMA DB
    #
    result = insert_document("entities", unique_id, doc)

    return jsonify({
        "success": True,
        "id": unique_id,
        "db_result": result,
        "embedding_status": embed_result
    }), 200
