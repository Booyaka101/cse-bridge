using Google.Apis.CustomSearchAPI.v1;
using Google.Apis.Services;

static class Search
{
    public static CustomSearchAPIService Legacy(string key) =>
        new CustomSearchAPIService(new BaseClientService.Initializer { ApiKey = key });

    // Moved to the bridge.

    public static CustomSearchAPIService Bridged(string key) =>
        new CustomSearchAPIService(new BaseClientService.Initializer
        {
            ApiKey = key,
            BaseUri = "http://localhost:8080/",
        });
}
