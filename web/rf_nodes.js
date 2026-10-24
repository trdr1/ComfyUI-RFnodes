import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

app.registerExtension({
    name: "RFNodes.Components",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name === "RFEntitySearchNode") {
            const onNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                if (onNodeCreated) onNodeCreated.apply(this, arguments);

                const node = this;
                const categoryWidget = this.widgets.find((w) => w.name === "category");
                const escapeWidget = this.widgets.find((w) => w.name === "escape_brackets");
                const resultWidget = this.widgets.find((w) => w.name === "result_text");

                const origQueryIdx = this.widgets.findIndex((w) => w.name === "search_query");
                let initialVal = "";
                if (origQueryIdx !== -1) {
                    initialVal = this.widgets[origQueryIdx].value || "";
                    this.widgets.splice(origQueryIdx, 1);
                }

                const inputEl = document.createElement("input");
                inputEl.type = "text";
                inputEl.value = initialVal;
                inputEl.placeholder = "search...";
                Object.assign(inputEl.style, {
                    width: "100%",
                    height: "24px",
                    lineHeight: "24px",
                    boxSizing: "border-box",
                    backgroundColor: "#18181f",
                    color: "#ddd",
                    border: "1px solid #3d3d4d",
                    borderRadius: "4px",
                    padding: "0 8px",
                    fontSize: "12px",
                    outline: "none",
                    margin: "0"
                });

                const queryWidget = this.addDOMWidget("search_query", "customtext", inputEl, {
                    getValue: () => inputEl.value,
                    setValue: (v) => { inputEl.value = v || ""; }
                });
                queryWidget.computeSize = (width) => [width, 34];

                if (origQueryIdx !== -1) {
                    const currentIdx = this.widgets.indexOf(queryWidget);
                    if (currentIdx !== -1) {
                        this.widgets.splice(currentIdx, 1);
                        this.widgets.splice(origQueryIdx, 0, queryWidget);
                    }
                }

                this.setSize(this.computeSize());

                let dropdown = null;
                let items = [];
                let activeIdx = 0;
                let timer = null;
                let reqId = 0;
                let isShowingSeriesChars = false;
                let currentSeriesContext = "";

                const getCategory = () => (categoryWidget ? categoryWidget.value : "characters");

                const escapeBrackets = (str) => {
                    if (!str) return str;
                    return str.replace(/\(/g, "\\(").replace(/\)/g, "\\)");
                };

                const removeDropdown = () => {
                    if (dropdown && dropdown.parentNode) dropdown.parentNode.removeChild(dropdown);
                    dropdown = null;
                    items = [];
                    activeIdx = 0;
                    isShowingSeriesChars = false;
                };

                const getAnchorRect = () => {
                    const r = inputEl.getBoundingClientRect();
                    return { left: r.left, bottom: r.bottom, width: r.width };
                };

                const targetPrefixes = ["1girl,", "1boy,", "1other,", "androgynous,"];

                const updateResultText = (currentText, newPrompt) => {
                    if (!currentText || !currentText.trim()) {
                        return newPrompt;
                    }
                    const lines = currentText.split("\n");
                    let replaced = false;
                    const newLines = lines.map((line) => {
                        const trimmed = line.trim().toLowerCase();
                        if (!replaced && targetPrefixes.some((p) => trimmed.startsWith(p))) {
                            replaced = true;
                            return newPrompt;
                        }
                        return line;
                    });
                    if (!replaced) {
                        newLines.unshift(newPrompt);
                    }
                    return newLines.join("\n");
                };

                const applyItem = (item) => {
                    if (!item) return;
                    const doEscape = escapeWidget ? escapeWidget.value : true;
                    const cat = getCategory();

                    if (cat === "series" && !isShowingSeriesChars) {
                        currentSeriesContext = item.name;
                        inputEl.value = item.name;
                        removeDropdown();
                        fetchAndShowSeriesCharacters(item.name);
                        return;
                    }

                    let promptOut = item.prompt;
                    if (isShowingSeriesChars && currentSeriesContext) {
                        promptOut = `1girl, ${item.name}, ${currentSeriesContext}`;
                    }

                    if (doEscape) promptOut = escapeBrackets(promptOut);

                    if (resultWidget) {
                        if (cat === "characters" || isShowingSeriesChars) {
                            resultWidget.value = updateResultText(resultWidget.value, promptOut);
                        } else {
                            resultWidget.value = promptOut;
                        }
                    }

                    if (!isShowingSeriesChars) {
                        inputEl.value = item.name;
                    }
                    removeDropdown();
                    app.graph.setDirtyCanvas(true, true);
                };

                const highlight = () => {
                    if (!dropdown) return;
                    const rows = dropdown.querySelectorAll("div[data-idx]");
                    rows.forEach((row, i) => {
                        row.style.background = i === activeIdx ? "#353545" : "transparent";
                        if (i === activeIdx) row.scrollIntoView({ block: "nearest" });
                    });
                };

                const showSuggestions = (list, isCharsList = false, headerTitle = "") => {
                    removeDropdown();
                    if (!list || list.length === 0) return;
                    items = list;
                    activeIdx = 0;
                    isShowingSeriesChars = isCharsList;

                    const rect = getAnchorRect();
                    dropdown = document.createElement("div");
                    Object.assign(dropdown.style, {
                        position: "fixed",
                        left: `${rect.left}px`,
                        top: `${rect.bottom + 2}px`,
                        width: `${Math.max(rect.width, 240)}px`,
                        maxHeight: "220px",
                        overflowY: "auto",
                        background: "#202028",
                        border: "1px solid #4a4a5a",
                        borderRadius: "4px",
                        zIndex: "99999",
                        boxShadow: "0 4px 14px rgba(0,0,0,0.6)",
                        fontSize: "12px",
                        fontFamily: "sans-serif",
                    });

                    if (headerTitle) {
                        const h = document.createElement("div");
                        h.dataset.isHeader = "true";
                        h.textContent = headerTitle;
                        Object.assign(h.style, {
                            padding: "4px 8px",
                            background: "#181822",
                            color: "#9399b2",
                            fontSize: "11px",
                            fontWeight: "bold",
                            borderBottom: "1px solid #313244",
                            position: "sticky",
                            top: "0",
                        });
                        dropdown.appendChild(h);
                    }

                    items.forEach((item, i) => {
                        const row = document.createElement("div");
                        row.dataset.idx = String(i);
                        row.textContent = item.name;
                        Object.assign(row.style, {
                            padding: "6px 10px",
                            color: "#e0e0e0",
                            cursor: "pointer",
                            borderBottom: "1px solid #2d2d3a",
                        });
                        row.addEventListener("mouseenter", () => { activeIdx = i; highlight(); });
                        row.addEventListener("mousedown", (e) => {
                            e.preventDefault();
                            applyItem(item);
                        });
                        dropdown.appendChild(row);
                    });
                    document.body.appendChild(dropdown);
                    highlight();
                };

                const fetchAndShowSeriesCharacters = async (seriesName) => {
                    if (!seriesName) return;
                    try {
                        const res = await fetch(
                            `/rf_nodes/series_characters?series=${encodeURIComponent(seriesName)}&limit=80`
                        );
                        const data = await res.json();
                        const chars = data.characters || [];
                        if (chars.length > 0) {
                            showSuggestions(
                                chars.map((c) => ({ name: c, prompt: c })),
                                true,
                                `【${seriesName}】所属キャラクター (スコア順)`
                            );
                        }
                    } catch (err) {
                        console.error("[RFNodes] series_characters failed", err);
                    }
                };

                const requestSuggestions = (q) => {
                    clearTimeout(timer);
                    q = (q || "").trim();
                    if (!q) { removeDropdown(); return; }
                    const cat = getCategory();

                    timer = setTimeout(async () => {
                        const myId = ++reqId;
                        try {
                            const res = await fetch(
                                `/rf_nodes/suggest?category=${encodeURIComponent(cat)}&query=${encodeURIComponent(q)}`
                            );
                            const data = await res.json();
                            if (myId !== reqId) return;
                            showSuggestions(data.results || [], false);
                        } catch (err) {
                            console.error("[RFNodes] suggest failed", err);
                        }
                    }, 120);
                };

                inputEl.addEventListener("input", () => {
                    if (isShowingSeriesChars) {
                        removeDropdown();
                    }
                    if (inputEl.value.includes("\n")) inputEl.value = inputEl.value.replace(/\n/g, "");
                    requestSuggestions(inputEl.value);
                });

                inputEl.addEventListener("click", () => {
                    if (getCategory() === "series" && inputEl.value.trim() && !dropdown) {
                        currentSeriesContext = inputEl.value.trim();
                        fetchAndShowSeriesCharacters(inputEl.value.trim());
                    }
                });

                inputEl.addEventListener("keydown", (e) => {
                    e.stopPropagation();
                    if (!dropdown) return;
                    if (e.key === "ArrowDown") {
                        e.preventDefault();
                        activeIdx = (activeIdx + 1) % items.length;
                        highlight();
                    } else if (e.key === "ArrowUp") {
                        e.preventDefault();
                        activeIdx = (activeIdx - 1 + items.length) % items.length;
                        highlight();
                    } else if (e.key === "Enter" || e.key === "Tab") {
                        e.preventDefault();
                        applyItem(items[activeIdx]);
                    } else if (e.key === "Escape") {
                        removeDropdown();
                    }
                });

                inputEl.addEventListener("blur", () => setTimeout(removeDropdown, 150));

                if (categoryWidget) {
                    const origCb = categoryWidget.callback;
                    categoryWidget.callback = function () {
                        if (origCb) origCb.apply(this, arguments);
                        removeDropdown();
                    };
                }

                const onRemoved = this.onRemoved;
                this.onRemoved = function () {
                    removeDropdown();
                    clearTimeout(timer);
                    if (onRemoved) onRemoved.apply(this, arguments);
                };
            };
        }

        if (nodeData.name === "RFSeriesCharacterListNode") {
            const onNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                if (onNodeCreated) onNodeCreated.apply(this, arguments);

                const seriesWidget = this.widgets.find((w) => w.name === "series_name");
                const charsWidget = this.widgets.find((w) => w.name === "characters_text");
                const formatWidget = this.widgets.find((w) => w.name === "format_mode");
                const genderWidget = this.widgets.find((w) => w.name === "gender_prefix");
                const limitWidget = this.widgets.find((w) => w.name === "limit");

                this.addWidget("button", "🔄 Fetch Characters into Box", null, async () => {
                    const sName = seriesWidget ? seriesWidget.value.trim() : "";
                    if (!sName) return;

                    const limit = limitWidget ? limitWidget.value : 30;
                    const fmt = formatWidget ? formatWidget.value : "dynamic_prompts";
                    const gPrefix = genderWidget ? genderWidget.value : "none";

                    try {
                        const res = await fetch(`/rf_nodes/series_characters?series=${encodeURIComponent(sName)}&limit=${limit}`);
                        const data = await res.json();
                        const list = data.characters || [];
                        if (list.length === 0) {
                            if (charsWidget) charsWidget.value = "";
                            return;
                        }

                        const cleanSeries = sName.replace(/_/g, " ");
                        const formatted = list.map((c) => {
                            const cleanC = c.replace(/_/g, " ");
                            const parts = [];
                            if (gPrefix !== "none") parts.push(gPrefix);
                            parts.push(cleanC);
                            if (cleanSeries) parts.push(cleanSeries);
                            return parts.join(", ");
                        });

                        let out = "";
                        if (fmt === "dynamic_prompts") {
                            out = "{\n" + formatted.map((l, idx) => (idx === 0 ? "$" : "|") + l).join("\n") + "\n}";
                        } else if (fmt === "newline") {
                            out = formatted.join("\n");
                        } else {
                            out = formatted.join(", ");
                        }

                        if (charsWidget) {
                            charsWidget.value = out;
                            app.graph.setDirtyCanvas(true, true);
                        }
                    } catch (err) {
                        console.error(err);
                    }
                });
            };
        }

        if (nodeData.name === "RFWildcardProcessorNode") {
            // 原因が分かったら false に(または console.log 行を削除)
            const DEBUG = true;
            const dbg = (...args) => { if (DEBUG) console.log("[RF wildcard]", ...args); };

            const onNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                if (onNodeCreated) onNodeCreated.apply(this, arguments);

                const node = this;
                const textWidget = this.widgets.find((w) => w.name === "text");
                const selectWidget = this.widgets.find((w) => w.name === "select_wildcard");
                const replaceWidget = this.widgets.find((w) => w.name === "replace_single_wildcard");

                dbg("onNodeCreated: node id =", node.id);

                if (textWidget) {
                    const origCompute = textWidget.computeSize;
                    textWidget.computeSize = function (width) {
                        const isConverted = this.type === "converted-widget" || (node.inputs && node.inputs.some((i) => i.name === "text" && i.link != null));
                        if (isConverted) {
                            return [width, -4];
                        }
                        return origCompute ? origCompute.apply(this, arguments) : [width, 60];
                    };

                    const syncTextVal = () => {
                        if (textWidget.inputEl) {
                            textWidget.value = textWidget.inputEl.value;
                        }
                    };

                    if (textWidget.inputEl) {
                        textWidget.inputEl.addEventListener("input", syncTextVal);
                        textWidget.inputEl.addEventListener("change", syncTextVal);
                    }

                    const origSerialize = textWidget.serializeValue;
                    textWidget.serializeValue = function () {
                        syncTextVal();
                        const v = origSerialize ? origSerialize.apply(this, arguments) : this.value;
                        // 実行時にバックエンドへ送られる text の値を確認できる
                        Promise.resolve(v).then((val) => dbg("serialize text ->", JSON.stringify(val)));
                        return v;
                    };
                }

                if (selectWidget) {
                    const defaultVal = "Select Wildcard...";
                    selectWidget.callback = function (v) {
                        if (!v || v === defaultVal) return;
                        const doReplace = replaceWidget ? replaceWidget.value : true;
                        let current = textWidget ? (textWidget.inputEl ? textWidget.inputEl.value : (textWidget.value || "")) : "";
                        const wcPattern = /__[\w.\-+/*\\]+?__/g;
                        const matches = current.match(wcPattern) || [];

                        if (doReplace && matches.length === 1) {
                            current = current.replace(matches[0], v);
                        } else {
                            if (current.trim().length === 0) {
                                current = v;
                            } else {
                                const sep = current.endsWith("\n") ? "" : (current.endsWith(",") ? " " : ", ");
                                current = current + sep + v;
                            }
                        }

                        if (textWidget) {
                            textWidget.value = current;
                            if (textWidget.inputEl) {
                                textWidget.inputEl.value = current;
                            }
                        }
                        selectWidget.value = defaultVal;
                        app.graph.setDirtyCanvas(true, true);
                    };
                }

                this.addWidget("button", "🔄 Refresh Wildcards", null, async () => {
                    try {
                        const res = await fetch("/rf_nodes/refresh_wildcards");
                        const data = await res.json();
                        if (selectWidget && data.wildcards) {
                            selectWidget.options.values = data.wildcards;
                            app.graph.setDirtyCanvas(true, true);
                        }
                    } catch (err) {
                        console.error(err);
                    }
                });

                const previewEl = document.createElement("textarea");
                previewEl.readOnly = true;
                previewEl.placeholder = "Result preview...";
                Object.assign(previewEl.style, {
                    width: "100%",
                    boxSizing: "border-box",
                    backgroundColor: "#16161c",
                    color: "#aaa",
                    border: "1px solid #333340",
                    borderRadius: "4px",
                    padding: "4px 8px",
                    fontSize: "11px",
                    outline: "none",
                    resize: "none",
                    margin: "0"
                });

                // 対策2: プレビュー欄の値を workflow 保存 / 実行入力に含めない
                const previewWidget = this.addDOMWidget("populated_preview", "customtext", previewEl, {
                    getValue: () => previewEl.value,
                    setValue: (v) => { previewEl.value = v || ""; },
                    serialize: false,
                });

                const adjustLayout = () => {
                    const isConverted = textWidget && (textWidget.type === "converted-widget" || (node.inputs && node.inputs.some((i) => i.name === "text" && i.link != null)));
                    if (isConverted && textWidget.inputEl) {
                        textWidget.inputEl.style.display = "none";
                        textWidget.inputEl.style.height = "0px";
                    }

                    let fixedHeight = 32;
                    for (const w of node.widgets) {
                        if (w === previewWidget) continue;
                        if (w === textWidget && isConverted) continue;
                        if (w.computeSize) {
                            const sz = w.computeSize(node.size[0]);
                            fixedHeight += (sz && sz[1] > 0) ? sz[1] + 4 : 24;
                        } else {
                            fixedHeight += 24;
                        }
                    }

                    const avail = Math.max(50, node.size[1] - fixedHeight - 16);
                    previewEl.style.height = `${avail}px`;
                    previewWidget.computeSize = (width) => [width, avail + 8];
                };

                const origOnResize = this.onResize;
                this.onResize = function (size) {
                    if (origOnResize) origOnResize.apply(this, arguments);
                    adjustLayout();
                };

                // ---------- 結果表示の更新(共通処理) ----------
                let updateCount = 0;
                const updatePreview = (source, message) => {
                    updateCount++;
                    const t = message && message.text;
                    dbg(`#${updateCount} [${source}] node=${node.id} message.text =`, t);

                    // 条件で弾いて黙ってスキップしない(理由をログに出す)
                    if (t == null) {
                        dbg(`#${updateCount} message.text が無いため更新スキップ。message =`, message);
                        return;
                    }

                    // 対策1: [0] ではなく「最後の要素」= 最新の結果を使う
                    let latest;
                    if (Array.isArray(t)) {
                        if (t.length > 1) {
                            dbg(`#${updateCount} 警告: message.text が ${t.length} 要素に増えている(追記されている)。最後の要素を採用`);
                        }
                        latest = t[t.length - 1];
                    } else {
                        latest = t;
                    }

                    const str = latest != null ? String(latest) : "";
                    const before = previewEl.value;
                    // 対策3: 値は textarea だけに直接書く(widget.value との二重代入をしない)
                    previewEl.value = str;
                    dbg(`#${updateCount} 更新: changed=${before !== str}, length ${before.length} -> ${str.length}`);
                    app.graph.setDirtyCanvas(true, true);
                };

                // 通常ルート: onExecuted
                const onExecuted = this.onExecuted;
                this.onExecuted = function (message) {
                    if (onExecuted) onExecuted.apply(this, arguments);
                    updatePreview("onExecuted", message);
                };

                // 対策4(保険): 他の拡張が onExecuted を上書きしても更新できるよう、
                // api の "executed" イベントも直接購読する
                const onApiExecuted = (e) => {
                    const d = e && e.detail;
                    if (!d) return;
                    if (String(d.node) !== String(node.id)) return;
                    updatePreview("api.executed", d.output);
                };
                api.addEventListener("executed", onApiExecuted);

                const origOnRemoved = this.onRemoved;
                this.onRemoved = function () {
                    api.removeEventListener("executed", onApiExecuted);
                    if (origOnRemoved) origOnRemoved.apply(this, arguments);
                };

                setTimeout(() => {
                    adjustLayout();
                    this.setSize([this.size[0], Math.max(this.size[1], 180)]);
                }, 40);
            };
        }
    }
});