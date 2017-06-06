import * as AST from './AST';
import * as sourcemap from './sourcemap';
// pre-compiled regular expressions
var rx = {
    backslashes: /\\/g,
    newlines: /\r?\n/g,
    hasParen: /\(/,
    loneFunction: /^function |^\(\w*\) =>|^\w+ =>/,
    upperStart: /^[A-Z]/,
    singleQuotes: /'/g,
    indent: /\n(?=[^\n]+$)([ \t]*)/
};
// genCode
AST.CodeTopLevel.prototype.genCode =
    AST.EmbeddedCode.prototype.genCode = function (opts) { return concatResults(opts, this.segments, 'genCode'); };
AST.CodeText.prototype.genCode = function (opts) {
    return markBlock(this.text, this.loc, opts);
};
AST.HtmlElement.prototype.genCode = function (opts, prior) {
    var code;
    if (rx.upperStart.test(this.tag)) {
        code = genSubComponent(this, opts, prior);
    }
    else if (this.properties.length === 0 && this.content.length === 0) {
        // optimization: don't need IIFE for simple single nodes
        code = "document.createElement(\"" + this.tag + "\")";
    }
    else {
        var block = new CodeBlock(), expr = this.genDOMStatements(opts, block, null, 0);
        code = block.toCode(expr, indent(prior));
    }
    return markLoc(code, this.loc, opts);
};
function genSubComponent(cmp, opts, prior) {
    var nl = "\r\n" + indent(prior), inl = nl + '    ', iinl = inl + '    ', props = cmp.properties.map(function (p) {
        return p instanceof AST.StaticProperty ? propName(opts, p.name) + ": " + p.value + "," :
            p instanceof AST.DynamicProperty ? propName(opts, p.name) + ": " + p.code.genCode(opts, prior) + "," :
                '';
    }), children = cmp.content.map(function (c) {
        return c instanceof AST.HtmlElement ? c.genCode(opts, prior) :
            c instanceof AST.HtmlText ? codeStr(c.text.trim()) :
                c instanceof AST.HtmlInsert ? c.code.genCode(opts, prior) :
                    createComment(c.text);
    });
    return cmp.tag + "({" + inl
        + props.join(inl) + inl
        + 'children: [' + iinl
        + children.join(',' + iinl) + inl
        + ']})';
}
var CodeBlock = (function () {
    function CodeBlock() {
        this.ids = [];
        this.inits = [];
        this.exes = [];
    }
    CodeBlock.prototype.id = function (id) { this.ids.push(id); return id; };
    CodeBlock.prototype.init = function (stmt) { this.inits.push(stmt); return stmt; };
    CodeBlock.prototype.exe = function (stmt) { this.exes.push(stmt); return stmt; };
    CodeBlock.prototype.toCode = function (expr, indent) {
        var nl = "\r\n" + indent, inl = nl + '    ', iinl = inl + '    ';
        return '(function () {' + iinl
            + 'var ' + this.ids.join(', ') + ';' + iinl
            + this.inits.join(iinl) + iinl
            + this.exes.join(iinl) + iinl
            + 'return ' + expr + ';' + inl
            + '})()';
    };
    return CodeBlock;
}());
export { CodeBlock };
// genDOMStatements
AST.HtmlElement.prototype.genDOMStatements = function (opts, code, parent, n) {
    var id = code.id(genIdentifier(parent, this.tag, n));
    if (rx.upperStart.test(this.tag)) {
        var expr = genSubComponent(this, opts, ""), range = "{ start: " + id + ", end: " + id + " }";
        code.init(assign(id, createText('')));
        code.exe(exe("Surplus.insert(range, " + expr + ");", "range", range, this.loc, opts));
    }
    else {
        var exelen = code.exes.length;
        code.init(assign(id, createElement(this.tag)));
        for (var i = 0; i < this.properties.length; i++) {
            this.properties[i].genDOMStatements(opts, code, id, i);
        }
        var myexes = code.exes.splice(exelen);
        for (i = 0; i < this.content.length; i++) {
            var child = this.content[i].genDOMStatements(opts, code, id, i);
            if (child)
                code.init(appendNode(id, child));
        }
        code.exes = code.exes.concat(myexes);
    }
    return id;
};
AST.HtmlComment.prototype.genDOMStatements = function (opts, code, parent, n) {
    return createComment(this.text);
};
AST.HtmlText.prototype.genDOMStatements = function (opts, code, parent, n) {
    if (n === 0) {
        code.init(parent + ".innerText = " + codeStr(this.text));
    }
    else {
        return createText(this.text);
    }
};
AST.HtmlInsert.prototype.genDOMStatements = function (opts, code, parent, n) {
    var id = code.id(genIdentifier(parent, 'insert', n)), ins = this.code.genCode(opts), range = "{ start: " + id + ", end: " + id + " }";
    code.init(assign(id, createText('')));
    code.exe(noApparentSignals(ins)
        ? "Surplus.insert(" + range + ", " + ins + ");"
        : exe("Surplus.insert(range, " + ins + ");", "range", range, this.loc, opts));
    return id;
};
AST.StaticProperty.prototype.genDOMStatements = function (opts, code, id, n) {
    code.init(id + "." + propName(opts, this.name) + " = " + this.value + ";");
};
AST.DynamicProperty.prototype.genDOMStatements = function (opts, code, id, n) {
    var expr = this.code.genCode(opts);
    if (this.name === "ref") {
        code.init(expr + " = " + id + ";");
    }
    else {
        var prop = propName(opts, this.name), setter = id + "." + prop + " = " + expr + ";";
        code.exe(noApparentSignals(expr)
            ? setter
            : exe(setter, "", "", this.loc, opts));
    }
};
AST.Mixin.prototype.genDOMStatements = function (opts, code, id, n) {
    var expr = this.code.genCode(opts);
    code.exe(exe("(" + expr + ")(" + id + ", __state);", "__state", "", this.loc, opts));
};
var genIdentifier = function (parent, tag, n) {
    return parent === null ? '__' : parent + (parent[parent.length - 1] === '_' ? '' : '_') + tag + (n + 1);
}, assign = function (id, expr) {
    return id + " = " + expr + ";";
}, appendNode = function (parent, child) {
    return "Surplus.appendChild(" + parent + ", " + child + ");";
}, createElement = function (tag) {
    return "Surplus.createElement('" + tag + "')";
}, createComment = function (text) {
    return "Surplus.createComment(" + codeStr(text) + ")";
}, createText = function (text) {
    return "Surplus.createTextNode(" + codeStr(text) + ")";
}, exe = function (code, varname, seed, loc, opts) {
    return markLoc(varname ? "Surplus.S(function (" + varname + ") { return " + code + " }" + (seed ? ", " + seed : '') + ");"
        : "Surplus.S(function () { " + code + " });", loc, opts);
};
function propName(opts, name) {
    return opts.jsx && name.substr(0, 2) === 'on' ? (name === 'onDoubleClick' ? 'ondblclick' : name.toLowerCase()) : name;
}
function noApparentSignals(code) {
    return !rx.hasParen.test(code) || rx.loneFunction.test(code);
}
function concatResults(opts, children, method, sep) {
    var result = "", i;
    for (i = 0; i < children.length; i++) {
        if (i && sep)
            result += sep;
        result += children[i][method](opts, result);
    }
    return result;
}
function indent(prior) {
    var m = rx.indent.exec(prior || '');
    return m ? m[1] : '';
}
function codeStr(str) {
    return "'" + str.replace(rx.backslashes, "\\\\")
        .replace(rx.singleQuotes, "\\'")
        .replace(rx.newlines, "\\\n")
        + "'";
}
function markLoc(str, loc, opts) {
    return opts.sourcemap ? sourcemap.locationMark(loc) + str : str;
}
function markBlock(str, loc, opts) {
    if (!opts.sourcemap)
        return str;
    var lines = str.split('\n'), offset = 0;
    for (var i = 1; i < lines.length; i++) {
        var line = lines[i];
        offset += line.length;
        var lineloc = { line: loc.line + i, col: 0, pos: loc.pos + offset + i };
        lines[i] = sourcemap.locationMark(lineloc) + line;
    }
    return sourcemap.locationMark(loc) + lines.join('\n');
}
