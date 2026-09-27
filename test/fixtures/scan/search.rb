require 'google/apis/customsearch_v1'

def legacy_service
  service = Google::Apis::CustomsearchV1::CustomSearchAPIService.new
  service.key = ENV.fetch('KEY')
  service
end

# Moved to the bridge.

def service
  service = Google::Apis::CustomsearchV1::CustomSearchAPIService.new
  service.root_url = 'http://localhost:8080/'
  service.key = ENV.fetch('KEY')
  service
end
