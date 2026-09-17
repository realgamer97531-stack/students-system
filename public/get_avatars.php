<?php
header('Access-Control-Allow-Origin: *');
header('Content-Type: application/json');

$avatarDir = 'avatars/';
if (!file_exists($avatarDir)) {
    echo json_encode(['success' => true, 'avatars' => []]);
    exit;
}

$files = scandir($avatarDir);
$avatars = [];
$allowed = ['jpg','jpeg','png','webp','gif','svg'];

foreach ($files as $file) {
    if ($file === '.' || $file === '..') continue;
    $ext = strtolower(pathinfo($file, PATHINFO_EXTENSION));
    if (in_array($ext, $allowed)) {
        $avatars[] = $avatarDir . $file;
    }
}

echo json_encode(['success' => true, 'avatars' => $avatars]);