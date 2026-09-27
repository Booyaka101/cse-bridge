package example;

import com.google.api.services.customsearch.v1.Customsearch;

class Search {
    static Customsearch legacy(HttpTransport transport, JsonFactory jsonFactory) {
        return new Customsearch.Builder(transport, jsonFactory, null)
            .setApplicationName("app")
            .build();
    }

    // Moved to the bridge.

    static Customsearch bridged(HttpTransport transport, JsonFactory jsonFactory) {
        return new Customsearch.Builder(transport, jsonFactory, null)
            .setApplicationName("app")
            .setRootUrl("http://localhost:8080/")
            .build();
    }
}
