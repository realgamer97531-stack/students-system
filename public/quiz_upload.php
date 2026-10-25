<?php
// رفع صور اختبارات المنصة على هوستينجر. السيرفر (Railway) بس اللي بيبعت هنا، بمفتاح سري.
// المفتاح في ملف quiz_upload_key.php جنب الملف ده (مش في git): <?php return 'المفتاح';
// ولازم يبقى نفس QUIZ_UPLOAD_SECRET في Railway.
header('Content-Type: application/json');

function fail($code, $message) {
    http_response_code($code);
    echo json_encode(['success' => false, 'message' => $message]);
    exit;
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') fail(405, 'POST only');

$keyFile = __DIR__ . '/quiz_upload_key.php';
if (!file_exists($keyFile)) fail(500, 'upload key not configured');
$secret = (string) (include $keyFile);
$given = isset($_SERVER['HTTP_X_QUIZ_UPLOAD_SECRET']) ? (string) $_SERVER['HTTP_X_QUIZ_UPLOAD_SECRET'] : '';
if (strlen($secret) < 24 || !hash_equals($secret, $given)) fail(403, 'forbidden');

if (!isset($_FILES['image']) || $_FILES['image']['error'] !== UPLOAD_ERR_OK) fail(400, 'no image');
if ($_FILES['image']['size'] > 8 * 1024 * 1024) fail(400, 'image too large');

$info = @getimagesize($_FILES['image']['tmp_name']);
$types = [IMAGETYPE_JPEG => 'jpg', IMAGETYPE_PNG => 'png', IMAGETYPE_WEBP => 'webp', IMAGETYPE_GIF => 'gif'];
if (!$info || !isset($types[$info[2]])) fail(400, 'not an image');

$folder = isset($_POST['folder']) && $_POST['folder'] === 'answers' ? 'answers' : 'questions';
$dir = __DIR__ . '/quiz-images/' . $folder . '/' . date('Y-m');
if (!is_dir($dir) && !mkdir($dir, 0755, true)) fail(500, 'cannot create folder');

// ممنوع تشغيل أي سكريبت من فولدر الصور
$htaccess = __DIR__ . '/quiz-images/.htaccess';
if (!file_exists($htaccess)) {
    file_put_contents($htaccess, "Options -Indexes\nRemoveHandler .php .phtml .php5 .php7 .phps\n<FilesMatch \"\\.(php|phtml|php5|php7|phps)$\">\nRequire all denied\n</FilesMatch>\n");
}

$name = bin2hex(random_bytes(12)) . '.' . $types[$info[2]];
if (!move_uploaded_file($_FILES['image']['tmp_name'], $dir . '/' . $name)) fail(500, 'save failed');

$scheme = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
$path = 'quiz-images/' . $folder . '/' . date('Y-m') . '/' . $name;
echo json_encode(['success' => true, 'url' => $scheme . '://' . $_SERVER['HTTP_HOST'] . '/' . $path]);
