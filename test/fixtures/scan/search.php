<?php

function legacyService(): Google\Service\CustomSearchAPI
{
    $client = new Google\Client();
    $client->setDeveloperKey(getenv('KEY'));
    return new Google\Service\CustomSearchAPI($client);
}

// Moved to the bridge.

function service(): Google\Service\CustomSearchAPI
{
    $client = new Google\Client();
    $client->setDeveloperKey(getenv('KEY'));
    $client->setConfig('base_path', 'http://localhost:8080');
    return new Google\Service\CustomSearchAPI($client);
}
