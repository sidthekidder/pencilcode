(function(module, define) {

function inferScriptType(filename) {
  var mime = mimeForFilename(filename);
  if (/^text\/x-pencilcode/.test(mime)) {
    mime = 'text/coffeescript';
  }
  // Script type attributes do not understand encoding.
  return mime.replace(/;.*$/, '');
}

// Scans for HTML HEAD content at the top, remembering the positions
// after any start-tags seen and before any legal end-tags.
// Returns {
//   pos: { map of tagname -> [index, length] }
//   hasbody: true if <body> tag starts the content.
//   bodypos: index of the <body> tag or first content text.
//
function scanHtmlTop(html) {
  var sofar = html, len, match, seen = {}, endpat, scanned = false,
      result = { pos: {} };
  for (;;) {
    len = sofar.length;
    // Trim leading space.
    sofar = sofar.replace(/^\s*/, '');
    if (sofar.length < len) { continue; }
    // Trim leading comment.
    sofar = sofar.replace(/^<!--[^-]*(?:-(?:[^-]|-[^>])[^-]*)*-*-->/, '');
    if (sofar.length < len) { scanned = true; continue; }
    // Detect acceptable tags within the HEAD.
    match = /^<([^\s>]+\b)\s*(?:[^\s=>]+\s*=\s*(?:[^\s>]+|'[^']*'|"[^"]")\s*)*\s*>/.exec(sofar);
    if (match && /^(?:!doctype|html|head|link|meta|base|title|script|style|\/\w+)$/i.test(match[1])) {
      scanned = true;
      if (!result.pos.hasOwnProperty(match[1].toLowerCase())) {
        result.pos[match[1].toLowerCase()] = {
          index: html.length - sofar.length,
          length: match[0].length
        };
      }
      sofar = sofar.substr(match[0].length);
      if (!/^(?:title|style|script)$/i.test(match[1])) {
        continue;
      }
      // Special cases: title, style, and script: skip any content text.
      endpat = new RegExp('</(' + match[1] + '\\b)[^>]*>', 'i');
      match = endpat.exec(sofar);
      if (match) {
        if (!result.pos.hasOwnProperty(match[1].toLowerCase())) {
          result.pos[match[1].toLowerCase()] = {
            index: html.length - sofar.length,
            length: match[0].length
          };
        }
        sofar = sofar.substr(match.index + match[0].length);
      }
      continue;
    }
    // The head ends here: notice if there is a body tag.
    if (match && /^body$/i.test(match[1])) {
      scanned = true;
      result.hasbody = true;
    }
    result.bodypos = scanned ? (html.length - sofar.length) : 0;
    return result;
  }
}

// The job of this function is to take: HTML, CSS, and script content,
// and merge them into one HTML file.
function wrapTurtle(doc, domain, pragmasOnly, setupScript) {
  // Construct the HTML for running a program.
  var meta = effectiveMeta(doc.meta);
  var html = meta.html || '';
  // pragmasOnly should never run dangerous script, so do not run
  // meta.html if the HTML has script.
  if (pragmasOnly && /<\/?script/i.test(html)) {
    html = '';
  }
  var topinfo = scanHtmlTop(html);
  var prefix = [], suffix = [];
  if (topinfo.pos['!doctype'] == null) {
    prefix.push('<!doctype html>');
    if (topinfo.pos['html'] == null) {
      prefix.push('<html>');
      suffix.unshift('</html>');
    }
  }
  // If any head items are required, find a location for them.
  if (meta.css) {
    var headneeded = (topinfo.bodypos == 0);
    if (headneeded) {
      // Create a head tag if the HTML has no leading items.
      prefix.push('<head>');
    }
    else {
      var splithead = topinfo.bodypos, newline = 0;
      if (topinfo.pos['/head']) {
        splithead = Math.min(splithead, topinfo.pos['/head'].index);
      }
      if (splithead > 0) {
        if (html.substr(splithead, 1) == '\n') { newline = 1; }
        prefix.push(html.substr(0, splithead - newline));
        html = html.substr(splithead);
      }
    }
    // Now insert the head items.
    prefix.push.apply(prefix, ['<style>', meta.css, '</style>']);
    if (headneeded) {
      prefix.push('</head>');
      if (!topinfo.hasbody) {
        prefix.push('<body>');
        suffix.unshift('</body>');
      }
    }
  } else if (topinfo.bodypos == 0 && !topinfo.hasbody) {
    // Surround by a body if no head content was present, and no body tag.
    prefix.push('<body>');
    suffix.unshift('</body>');
  } else if (html.substr(topinfo.bodypos).trim() == '') {
    // Append an empty body if the HTML is all head.
    suffix.unshift('<body></body>');
  }

  // Add the default scripts.
  var j, scripts = [], src, text = doc.data;
  for (j = 0; j < meta.libs.length; ++j) {
    src = meta.libs[j].src;
    var attrs = '';
    if (meta.libs[j].attrs) {
      for (var att in meta.libs[j].attrs) {
        attrs += ' ' + att + '="' + escapeHtml(meta.libs[j].attrs[att]) + '"';
      }
    }
    if (/{site}/.test(src)) {
      src = src.replace(/{site}/g, domain);
      // Note that for local scripts we use crossorigin="anonymous" so that
      // we can get // more detailed error information (e.g., CoffeeScript
      // compilation // errors, using CORS rules.)  More discussion:
      // http://blog.errorception.com/2012/12/catching-cross-domain-js-errors.html
      scripts.push(
        '<script src="' + src + '" crossorigin="anonymous"' +
        attrs + '><\057script>');
    } else {
      scripts.push(
        '<script src="' + src + '"' + attrs + '><\057script>');
    }
  }
  // Then add any setupScript supplied.
  if (setupScript) {
    for (j = 0; j < setupScript.length; ++j) {
      if (setupScript[j].src) {
        scripts.push(
          '<script src="' + setupScript[j].url + '" type="' +
          (setupScript[j].type || inferScriptType(setupScript[j].url)) +
          '">\n<\057script>');
      } else if (setupScript[j].code) {
        scripts.push(
          '<script' +
          (setupScript[j].type ? ' type="' + setupScript[j].type + '"' : '') +
          '>\n' +
          setupScript[j].code +
          '\n<\057script>');
      }
    }
  }
  // Finally assemble the main script.
  var maintype = 'text/coffeescript';
  if (doc.meta && doc.meta.type) {
    maintype = doc.meta.type;
  }
  var seeline = '\n\n';
  var trailing = '\n';
  if (/javascript/.test(maintype)) {
    seeline = 'eval(this._start_ide_js_);\n\n';
  } else if (/coffeescript/.test(maintype)) {
    seeline = 'eval(this._start_ide_cs_)\n\n';
  }
  var mainscript = '<script type="' + maintype + '">\n' + seeline;
  if (!pragmasOnly) {
    mainscript += text;
  }
  mainscript += trailing + '<\057script>';
  var result = (
    prefix.join('\n') +
    html +
    scripts.join('') +
    mainscript +
    suffix.join(''));
  return result;
}

function escapeHtml(s) {
  return ('' + s).replace(/"/g, '&quot;').replace(/</g, '&lt;')
                 .replace(/>/g, '&gt;').replace(/\&/g, '&amp;');
}

function modifyForPreview(doc, domain,
       filename, targetUrl, pragmasOnly, sScript) {
  var mimeType = mimeForFilename(filename), text = doc.data;
  if (mimeType && /^text\/x-pencilcode/.test(mimeType)) {
    text = wrapTurtle(doc, domain, pragmasOnly, sScript);
    mimeType = mimeType.replace(/\/x-pencilcode/, '/html');
  } else if (pragmasOnly) {
    var safe = false;
    if (mimeType && /^text\/html/.test(mimeType) &&
        !text.match(/<script|<i?frame|<object/i)) {
      // Only preview HTML if there is no script.
      safe = true;
    }
    if (mimeType && /^image\/svg/.test(mimeType)) {
      // SVG preview is useful.
      safe = true;
    }
    // For now, we don't support inserting startup script in anything
    // other than the types above.
    if (!safe) {
      return '';
    }
  }
  if (!text) return '';
  if (mimeType && /image\/svg/.test(mimeType) &&
        !/<(?:[\w]+:)?svg[^>]+xmlns/.test(text)) {
    // Special case svg-without-namespace support.
    return text +
      '<pre>To use this svg as an image, add xmlns:\n' +
      '&lt;svg <mark>xmlns="http://www.w3.org/2000/svg"</mark>&gt;</pre>';
  }
  if (mimeType && /^image\//.test(mimeType)) {
    // For other image types, generate a document with nothing
    // but an image tag.
    var result = [
      '<!doctype html>',
      '<html style="min-height:100%">',
      '<body>',
      '<img src="data:' + mimeType.replace(/\s/g, '') + ';base64,' +
         btoa(text) + '" style="position:absolute;top:0;bottom:0;left:0;right:0;margin:auto;background:url(/image/checker.png)">',
      '</body>',
      '</html>'
    ];
    return result.join('\n');;
  }
  if (mimeType && !/^text\/html/.test(mimeType)) {
    return '<PLAINTEXT>' + text;
  }
  if (targetUrl && !/<base/i.exec(text)) {
    // Insert a <base href="target_url" /> in a good location.
    var firstLink = text.match(
          /(?:<link|<script|<style|<body|<img|<iframe|<frame|<meta|<a)\b/i),
        insertLocation = [
          text.match(/<head\b[^>]*>\n?/i),
          text.match(/<html\b[^>]*>\n?/i),
          text.match(/<\!doctype\b[^>]*>\n?/i)
        ],
        insertAt = 0, j, match;
    for (j = 0; j < insertLocation.length; ++j) {
      match = insertLocation[j];
      if (match && (!firstLink || match.index < firstLink.index)) {
        insertAt = match.index + match[0].length;
        break;
      }
    }
    return text.substring(0, insertAt) +
             '<base href="' + targetUrl + '" />\n' +
             text.substring(insertAt);
  }
  return text;
}


function mimeForFilename(filename) {
  var result = filename && filename.indexOf('.') > 0 && {
    'jpg'  : 'image/jpeg',
    'jpeg' : 'image/jpeg',
    'gif'  : 'image/gif',
    'png'  : 'image/png',
    'svg'  : 'image/svg+xml',
    'bmp'  : 'image/x-ms-bmp',
    'ico'  : 'image/x-icon',
    'htm'  : 'text/html',
    'html' : 'text/html',
    'txt'  : 'text/plain',
    'text' : 'text/plain',
    'css'  : 'text/css',
    'coffee' : 'text/coffeescript',
    'js'   : 'text/javascript',
    'xml'  : 'text/xml'
  }[filename.replace(/^.*\./, '')]
  if (!result) {
    result = 'text/x-pencilcode';
  }
  if (/^text\//.test(result)) {
    result += ';charset=utf-8';
  }
  return result;
}

function effectiveMeta(meta) {
  if (meta && meta.type && meta.lib) { return meta; }
  meta = (meta && 'object' == typeof meta) ?
    JSON.parse(JSON.stringify(meta)) : {};
  if (!meta.type) {
    meta.type = 'text/coffeescript';
  }
  if (!meta.libs) {
    meta.libs = [
      {name: 'turtle', src: '//{site}/turtlebits.js'}
    ];
  }
  return meta;
}

function isDefaultMeta(meta) {
  if (meta == null) return true;
  if (JSON.stringify(effectiveMeta(meta)) ==
      '{"type":"text/coffeescript","libs":' +
      '[{"name":"turtle","src":"//{site}/turtlebits.js"}]}') return true;
  return false;
}

var impl = {
  mimeForFilename: mimeForFilename,
  modifyForPreview: modifyForPreview,
  effectiveMeta: effectiveMeta,
  isDefaultMeta: isDefaultMeta,
  wrapTurtle: wrapTurtle
};

if (module && module.exports) {
  module.exports = impl;
} else if (define && define.amd) {
  define(function() { return impl; });
}

})(
  (typeof module) == 'object' && module,
  (typeof define) == 'function' && define
);
