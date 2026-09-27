from google.api_core.client_options import ClientOptions
from googleapiclient.discovery import build


def legacy_search(q):
    service = build("customsearch", "v1", developerKey=KEY)
    return service.cse().list(q=q, cx=CX).execute().get("items", [])


# Moved to the bridge.


def search(q):
    service = build(
        "customsearch", "v1",
        developerKey=KEY,
        client_options=ClientOptions(api_endpoint="http://localhost:8080"),
    )
    return service.cse().list(q=q, cx=CX).execute().get("items", [])
