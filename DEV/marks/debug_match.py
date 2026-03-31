# debug_match.py
from google.cloud.aiplatform_v1beta1.services.match_service import MatchServiceClient

client = MatchServiceClient()
methods = [m for m in dir(client) if "upsert" in m.lower()]
print("MatchServiceClient methods containing 'upsert':", methods)

print("All methods:")
for method in dir(client):
    print(method)
