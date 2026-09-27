from google.api_core.client_options import ClientOptions
from googleapiclient.discovery import build
from langchain_google_community import GoogleSearchAPIWrapper

legacy = GoogleSearchAPIWrapper(google_api_key=KEY, google_cse_id=CX)


# Moved to the bridge.


search = GoogleSearchAPIWrapper(google_api_key=KEY, google_cse_id=CX)
search.search_engine = build(
    "customsearch", "v1",
    developerKey=KEY,
    client_options=ClientOptions(api_endpoint="http://localhost:8080"),
)
