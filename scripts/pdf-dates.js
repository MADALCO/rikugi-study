ObjC.import('Quartz');

// macOSのPDFKitで各PDFの作成日とページ数を読み、TSVで標準出力に返す。本文は読まない。
// 使い方: osascript -l JavaScript scripts/pdf-dates.js pdfs/raw
function run(argv) {
  var dir = argv[0];
  var names = ObjC.deepUnwrap($.NSFileManager.defaultManager.contentsOfDirectoryAtPathError(dir, null))
    .filter(function (name) { return /\.pdf$/.test(name); })
    .sort();
  return names
    .map(function (name) {
      var doc = $.PDFDocument.alloc.initWithData($.NSData.dataWithContentsOfFile(dir + '/' + name));
      if (!doc || !doc.pageCount) return name + '\t\t0';
      var attrs = ObjC.deepUnwrap(doc.documentAttributes) || {};
      var created = attrs.CreationDate ? new Date(attrs.CreationDate).toISOString().slice(0, 10) : '';
      return name + '\t' + created + '\t' + doc.pageCount;
    })
    .join('\n');
}
