#!/bin/bash
# ⚠️ 备选方案：国别信息检索脚本 — 使用权威免费 API
# 首选工具：Tavily MCP（tavily_search / tavily_extract）
# 本脚本仅在 Tavily MCP 不可用时作为备选方案使用。
# 用法:
#   bash search.sh wiki-search "关键词"          # Wikipedia 搜索
#   bash search.sh wiki-page 页面ID               # Wikipedia 页面内容
#   bash search.sh wiki-summary "英文国名"         # Wikipedia 国家摘要
#   bash search.sh wb-data ISO代码 指标代码        # World Bank 数据
#   bash search.sh fetch "https://URL"            # 直接抓取 URL

MODE="${1:-wiki-search}"
INPUT="${2}"
INPUT2="${3}"

UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
TIMEOUT=15

case "$MODE" in
    wiki-search)
        query=$(echo "$INPUT" | sed 's/ /%20/g')
        curl -s --connect-timeout "$TIMEOUT" -A "$UA" \
            "https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${query}&format=json&srlimit=5"
        ;;
    wiki-page)
        curl -s --connect-timeout "$TIMEOUT" -A "$UA" \
            "https://en.wikipedia.org/w/api.php?action=query&prop=extracts&exintro&explaintext&pageids=${INPUT}&format=json"
        ;;
    wiki-summary)
        name=$(echo "$INPUT" | sed 's/ /%20/g')
        curl -s --connect-timeout "$TIMEOUT" -A "$UA" \
            "https://en.wikipedia.org/api/rest_v1/page/summary/${name}"
        ;;
    wb-data)
        curl -s --connect-timeout "$TIMEOUT" -A "$UA" \
            "https://api.worldbank.org/v2/country/${INPUT}/indicator/${INPUT2}?format=json&per_page=3"
        ;;
    fetch)
        curl -sL --connect-timeout "$TIMEOUT" -A "$UA" "$INPUT" | \
            sed 's/<script[^>]*>.*<\/script>//g; s/<style[^>]*>.*<\/style>//g; s/<[^>]*>//g; s/&nbsp;/ /g; s/&amp;/\&/g' | \
            tr -s ' \t\n' ' ' | head -c 3000
        ;;
    *)
        echo "用法:"
        echo "  bash search.sh wiki-search <关键词>"
        echo "  bash search.sh wiki-page <页面ID>"
        echo "  bash search.sh wiki-summary <英文国名>"
        echo "  bash search.sh wb-data <ISO代码> <指标>"
        echo "  bash search.sh fetch <URL>"
        exit 1
        ;;
esac
