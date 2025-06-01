from google.cloud import aiplatform_v1          # Needed for PredictionServiceClient
from google.cloud import aiplatform_v1beta1     # Needed for MatchServiceClient (vector upsert)
from google.cloud import firestore              # Needed for Firestore schema insert


PROJECT_ID = "the-leedz"
LOCATION = "us-west2"

# For embedding
EMBEDDING_MODEL_ID = "gemini-embedding-001"
EMBEDDING_ENDPOINT = f"projects/{PROJECT_ID}/locations/{LOCATION}/publishers/google/models/{EMBEDDING_MODEL_ID}"

# For Matching Engine
VECTOR_INDEX_ID = "336872770564521984"
VECTOR_ENDPOINT_ID = "2119559351189372928"




def embed_text(text):
    client = aiplatform_v1.PredictionServiceClient()
    instances = [{"content": text}]
    response = client.predict(endpoint=EMBEDDING_ENDPOINT, instances=instances, parameters={})
    return response.predictions[0]["embeddings"]["values"]




def save_embedding(vector_id: str, embedding: list):
    client = aiplatform_v1beta1.MatchServiceClient()

    index_endpoint = f"projects/{PROJECT_ID}/locations/{LOCATION}/indexEndpoints/{VECTOR_ENDPOINT_ID}"

    request = {
        "index_endpoint": index_endpoint,
        "deployed_index_id": "default",  # your deployment group
        "datapoints": [{
            "datapoint_id": vector_id,
            "feature_vector": embedding
        }]
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
def insert_vector(schema_data, orig_text):
    if not orig_text:
        return {"status": "skipped", "reason": "empty text"}

    flattened = "\n".join(str(v) for k, v in schema_data.items() if isinstance(v, (str, list)))

    full_input = f"{flattened}\n\n{orig_text}"

    try:
        embedding = embed_text(full_input)

        #
        # store in vector db
        #
        save_embedding(schema_data["name"].lower().replace(" ", "_"), embedding)
        return {"status": "embedded", "dimensions": len(embedding)}
    
    except Exception as e:
        return {"status": "error", "message": str(e)}



#
# Get an existing entity fromthe schema db if one exists
#
def get_mark( mark_id ):

    db = firestore.Client()

    existing_doc = db.collection("entities").document(mark_id).get()

    return existing_doc


