import re
import hashlib

from google.cloud import firestore
from google.cloud.aiplatform_v1 import PredictionServiceClient
from google.cloud.aiplatform_v1.services.index_service import IndexServiceClient


PROJECT_ID = "the-leedz"
LOCATION = "us-west2"

EMBEDDING_MODEL_ID = "gemini-embedding-001"
EMBEDDING_ENDPOINT = f"projects/{PROJECT_ID}/locations/{LOCATION}/publishers/google/models/{EMBEDDING_MODEL_ID}"

# This is the Index ID, not Index Endpoint
VECTOR_INDEX_ID = "336872770564521984"


# Normalize text for identity key
def normalize(text):
    if not text:
        return ""
    
    text = text.strip().lower()
    text = re.sub(r"\s+", " ", text)         # Collapse multiple spaces
    text = re.sub(r"[^a-z0-9@._\- ]", "", text)  # Remove emojis, weird punctuation
    return text


#
# use a Deterministic Compound ID
# Create a SHA1 hash
# take first 8 characters
#
# different scrapers referencing the same person (even partially) hash to the same ID
#
# key = normalized_name_first_8_chars_of_sha1_hash
#
def createUniqueKey(name, email, linkedin_url):
    norm_name = normalize(name)
    norm_email = normalize(email)
    raw = f"{norm_name}|{norm_email}|{linkedin_url}"
    short_hash = hashlib.sha1(raw.encode()).hexdigest()[:8]
    return f"{norm_name}_{short_hash}"




def embed_text(text):
    client = PredictionServiceClient()
    instances = [{"content": text}]
    response = client.predict(endpoint=EMBEDDING_ENDPOINT, instances=instances, parameters={})
    return response.predictions[0]["embeddings"]["values"]




def save_embedding(vector_id: str, embedding: list):
    client = IndexServiceClient()
    index_path = f"projects/{PROJECT_ID}/locations/{LOCATION}/indexes/{VECTOR_INDEX_ID}"
    request = {
        "index": index_path,
        "datapoints": [
            {
                "datapoint_id": vector_id,
                "feature_vector": embedding
            }
        ]
    }
    response = client.upsert_datapoints(request=request)
    return {"status": "upserted", "count": len(response.upserted_datapoint_ids)}



#
# insert the schema data into the (default) schema db
#
def insert_document(collection, doc_id, data):
    db = firestore.Client()
    doc_ref = db.collection(collection).document(doc_id)
    doc_ref.set(data)
    return {"status": "written"}


#
# embed the schema+original text --> store in vector db
#
def insert_vector(unique_key, schema_data, orig_text):
    if not orig_text:
        return {"status": "skipped", "reason": "empty text"}

    flattened = "\n".join(str(v) for k, v in schema_data.items() if isinstance(v, (str, list)))

    full_input = f"{flattened}\n\n{orig_text}"

    try:
        embedding = embed_text(full_input)

        #
        # store in vector db
        #
        save_embedding(unique_key, embedding)
        return {"status": "embedded", "id": unique_key }
    
    except Exception as e:
        return {"status": "error", "message": str(e)}



#
# Get an existing entity fromthe schema db if one exists
#
def get_mark( mark_id ):

    db = firestore.Client()

    existing_doc = db.collection("entities").document(mark_id).get()

    return existing_doc


