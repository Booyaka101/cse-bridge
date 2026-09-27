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
    return new Google\Service\CustomSearchAPI($client, 'http://localhost:8080/');
}
