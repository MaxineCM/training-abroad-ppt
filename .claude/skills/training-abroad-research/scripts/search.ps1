<#
.SYNOPSIS
  ⚠️ 备选方案：国别信息检索工具
  首选工具：Tavily MCP（tavily_search / tavily_extract）
  本脚本仅在 Tavily MCP 不可用时作为备选方案使用。
.DESCRIPTION
  Search 模式: 通过 Bing 搜索关键词
  Fetch  模式: 直接获取指定 URL 的文本内容
.PARAMETER Query
  搜索关键词
.PARAMETER Url
  要获取内容的 URL
.PARAMETER Mode
  search 或 fetch
.PARAMETER MaxResults
  最大结果数，默认 8
.EXAMPLE
  powershell -File scripts/search.ps1 -Query "Singapore GDP 2025"
  powershell -File scripts/search.ps1 -Url "https://www.singstat.gov.sg" -Mode fetch
#>

param(
    [string]$Query,
    [string]$Url,
    [string]$Mode = "search",
    [int]$MaxResults = 8
)

$OutputEncoding = [System.Text.Encoding]::UTF8

# ========== Search Mode ==========
function Do-Search {
    param([string]$Query, [int]$Max)

    $encoded = [System.Web.HttpUtility]::UrlEncode($Query)
    $searchUrl = "https://www.bing.com/search?q=$encoded"

    try {
        $resp = Invoke-WebRequest -Uri $searchUrl -UseBasicParsing -TimeoutSec 15 -Headers @{
            "User-Agent" = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
            "Accept-Language" = "zh-CN,en-US;q=0.9"
        }
    }
    catch {
        Write-Error "搜索请求失败: $_"
        return @()
    }

    $results = @()
    $html = $resp.Content

    # 提取搜索结果条目
    $algoPattern = '<li class="b_algo"[^>]*>.*?<h2[^>]*><a[^>]*href="([^"]+)"[^>]*>(.*?)</a></h2>'
    $algoMatches = [regex]::Matches($html, $algoPattern, [System.Text.RegularExpressions.RegexOptions]::Singleline)

    foreach ($m in $algoMatches) {
        if ($results.Count -ge $Max) { break }
        $href = $m.Groups[1].Value
        $title = $m.Groups[2].Value -replace '<[^>]*>', ''
        $results += @{ Title = $title.Trim(); Url = $href; Snippet = "" }
    }

    # 回退：提取所有外部链接
    if ($results.Count -eq 0) {
        $linkPat = '<a[^>]*href="(https?://[^"]+)"[^>]*>(.*?)</a>'
        $linkMatches = [regex]::Matches($html, $linkPat)
        foreach ($lm in $linkMatches) {
            if ($results.Count -ge $Max) { break }
            $href = $lm.Groups[1].Value
            $text = $lm.Groups[2].Value -replace '<[^>]*>', ''
            if ($href -notmatch 'bing\.com|microsoft\.com|go\.microsoft' -and $text.Trim() -ne '') {
                $results += @{ Title = $text.Trim(); Url = $href; Snippet = "" }
            }
        }
    }

    return $results
}

# ========== Fetch Mode ==========
function Do-Fetch {
    param([string]$Url)

    $result = @{ Url = $Url; StatusCode = 0; ContentText = ""; Error = "" }

    try {
        $resp = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 20 -Headers @{
            "User-Agent" = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
            "Accept-Language" = "zh-CN,en-US;q=0.9"
        }
        $result.StatusCode = $resp.StatusCode

        # 去除 HTML 标签
        $text = $resp.Content
        $text = $text -replace '<script[^>]*>[\s\S]*?</script>', ' '
        $text = $text -replace '<style[^>]*>[\s\S]*?</style>', ' '
        $text = $text -replace '<[^>]+>', ' '
        $text = $text -replace '&nbsp;', ' '
        $text = $text -replace '&amp;', '&'
        $text = $text -replace '&lt;', '<'
        $text = $text -replace '&gt;', '>'
        $text = $text -replace '&quot;', '"'
        $text = $text -replace '\s+', ' '

        if ($text.Length -gt 5000) {
            $text = $text.Substring(0, 5000) + "...[截断]"
        }

        $result.ContentText = $text.Trim()
    }
    catch {
        $result.Error = $_.Exception.Message
    }

    return $result
}

# ========== Main ==========
if ($Mode -eq "fetch") {
    if (-not $Url) {
        Write-Error "Fetch 模式需要 -Url"
        exit 1
    }
    $output = Do-Fetch -Url $Url
}
else {
    if (-not $Query) {
        Write-Error "Search 模式需要 -Query"
        exit 1
    }
    $output = Do-Search -Query $Query -Max $MaxResults
}

$json = $output | ConvertTo-Json -Depth 3 -Compress
Write-Output $json
exit 0
