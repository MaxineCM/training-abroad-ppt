#!/usr/bin/env python3
"""
火山引擎图片生成工具
使用火山方舟 (Ark) API 生成高质量图片

支持模型:
- doubao-seedream-3-0-t2i-250115 (Seedream 3.0)
- doubao-seedream-4-0-t2i-250115 (Seedream 4.0)
- doubao-seedream-4-5-251128 (Seedream 4.5)

使用方法:
    python3 generate.py --prompt "一只可爱的猫咪" --output cat.png
"""

import os
import sys
import json
import base64
import requests
import argparse
from pathlib import Path
from dotenv import load_dotenv
from datetime import datetime

# 加载 .env 文件
env_path = Path(__file__).parent.parent / '.env'
if env_path.exists():
    load_dotenv(env_path)

# 默认配置
DEFAULT_ENDPOINT = os.environ.get('VOLCENGINE_IMAGE_ENDPOINT', 'https://ark.cn-beijing.volces.com/api/v3')
DEFAULT_MODEL = os.environ.get('VOLCENGINE_IMAGE_DEFAULT_MODEL', 'doubao-seedream-4-5-251128')
API_KEY = os.environ.get('VOLCENGINE_IMAGE_API_KEY')

# 支持的模型列表
SUPPORTED_MODELS = {
    "doubao-seedream-3-0-t2i-250115": "Seedream 3.0",
    "doubao-seedream-4-0-t2i-250115": "Seedream 4.0",
    "doubao-seedream-4-5-251128": "Seedream 4.5",
}

# 支持的尺寸比例
SUPPORTED_SIZES = {
    "1:1": (1024, 1024),
    "2:3": (1024, 1536),
    "3:2": (1536, 1024),
    "16:9": (1920, 1080),
    "9:16": (1080, 1920),
    "4:3": (1440, 1080),
    "3:4": (1080, 1440),
}


def validate_size(width: int, height: int) -> bool:
    """验证尺寸是否满足最小像素要求 (3686400 pixels)"""
    return width * height >= 3686400


def get_size_from_ratio(ratio: str) -> tuple:
    """根据比例获取尺寸"""
    return SUPPORTED_SIZES.get(ratio, (1024, 1024))


def generate_image(
    prompt: str,
    model: str = None,
    width: int = None,
    height: int = None,
    ratio: str = "1:1",
    n: int = 1,
    output_path: str = None,
    response_format: str = "b64_json",
    watermark: bool = True,
    api_key: str = None,
    endpoint: str = None
) -> list:
    """
    生成图片
    
    Args:
        prompt: 图片描述提示词
        model: 模型名称
        width: 图片宽度 (可选，与 ratio 二选一)
        height: 图片高度 (可选，与 ratio 二选一)
        ratio: 图片比例 (1:1, 16:9, 9:16, 4:3, 3:4, 2:3, 3:2)
        n: 生成数量 (1-4)
        output_path: 输出文件路径
        response_format: 响应格式 (b64_json 或 url)
        watermark: 是否添加水印
        api_key: API Key
        endpoint: API 端点
        
    Returns:
        list: 生成的图片路径列表
    """
    api_key = api_key or API_KEY
    if not api_key:
        raise ValueError("未找到 API Key，请设置 VOLCENGINE_IMAGE_API_KEY 环境变量或在 .env 文件中配置")
    
    model = model or DEFAULT_MODEL
    endpoint = endpoint or DEFAULT_ENDPOINT
    
    # 确定尺寸
    if width and height:
        if not validate_size(width, height):
            raise ValueError(f"图片尺寸不满足最小像素要求 (>= 3686400 pixels): {width}x{height} = {width*height}")
        size_str = f"{width}x{height}"
    else:
        w, h = get_size_from_ratio(ratio)
        # 如果比例尺寸不满足最小像素，放大到 2K
        if not validate_size(w, h):
            scale = int((3686400 / (w * h)) ** 0.5) + 1
            w, h = w * scale, h * scale
        size_str = f"{w}x{h}"
    
    # 构建请求
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}"
    }
    
    payload = {
        "model": model,
        "prompt": prompt,
        "n": n,
        "size": size_str,
        "response_format": response_format,
        "watermark": watermark,
        "stream": False
    }
    
    # 发送请求
    try:
        response = requests.post(
            f"{endpoint}/images/generations",
            headers=headers,
            json=payload,
            timeout=120
        )
        
        if response.status_code != 200:
            error_data = response.json()
            error_msg = error_data.get('error', {}).get('message', '未知错误')
            raise Exception(f"API 请求失败: {error_msg}")
        
        result = response.json()
        
        # 保存图片
        output_paths = []
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        
        # 确定输出目录
        if output_path:
            output_dir = Path(output_path).parent if Path(output_path).suffix else Path(output_path)
            output_name = Path(output_path).stem if Path(output_path).suffix else None
        else:
            output_dir = Path(".")
            output_name = None
        
        output_dir.mkdir(parents=True, exist_ok=True)
        
        for i, img_data in enumerate(result["data"]):
            # 获取图片数据
            if response_format == "b64_json":
                b64_data = img_data.get("b64_json", "")
                if not b64_data:
                    raise ValueError(f"响应中未找到图片数据")
                img_bytes = base64.b64decode(b64_data)
            else:
                url = img_data.get("url", "")
                if not url:
                    raise ValueError(f"响应中未找到图片 URL")
                img_response = requests.get(url, timeout=30)
                img_bytes = img_response.content
            
            # 生成文件名
            if output_name:
                if n > 1:
                    filename = f"{output_name}_{i+1}.png"
                else:
                    filename = f"{output_name}.png"
            else:
                filename = f"{timestamp}_volcengine_img_{i+1}.png"
            
            filepath = output_dir / filename
            
            # 保存
            with open(filepath, "wb") as f:
                f.write(img_bytes)
            
            output_paths.append(str(filepath.absolute()))
        
        return output_paths
        
    except requests.exceptions.RequestException as e:
        raise Exception(f"网络请求失败: {e}")
    except Exception as e:
        raise Exception(f"图片生成失败: {e}")


def list_models():
    """列出支持的模型"""
    print("\n=== 支持的模型 ===\n")
    for model_id, model_name in SUPPORTED_MODELS.items():
        print(f"  {model_id}")
        print(f"    └─ {model_name}")
    print(f"\n默认模型: {DEFAULT_MODEL}")
    
    print("\n=== 支持的尺寸比例 ===\n")
    for ratio, (w, h) in SUPPORTED_SIZES.items():
        pixels = w * h
        status = "✅" if validate_size(w, h) else "⚠️ 会自动放大"
        print(f"  {ratio:>6} -> {w}x{h} ({pixels:,} pixels) {status}")
    print(f"\n注意: 最小像素要求为 3,686,400 (约 1920x1920)")


def main():
    parser = argparse.ArgumentParser(
        description='火山引擎图片生成工具',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog='''
示例:
  # 基础生成
  python3 generate.py "一只可爱的猫咪" -o cat.png
  
  # 指定比例
  python3 generate.py "科幻城市夜景" -r 16:9 -o city.png
  
  # 指定尺寸
  python3 generate.py "山水画" -W 2048 -H 2048 -o landscape.png
  
  # 使用特定模型
  python3 generate.py "赛博朋克风格" -m doubao-seedream-4-0-t2i-250115 -o cyber.png
  
  # 生成多张
  python3 generate.py "不同角度的跑车" -n 4 -o car.png
        '''
    )
    parser.add_argument('prompt', nargs='?', help='图片描述提示词')
    parser.add_argument('-o', '--output', help='输出文件路径 (默认: 自动生成)')
    parser.add_argument('-m', '--model', default=DEFAULT_MODEL, help='模型名称')
    parser.add_argument('-r', '--ratio', default='1:1', choices=list(SUPPORTED_SIZES.keys()),
                       help='图片比例 (默认: 1:1)')
    parser.add_argument('-W', '--width', type=int, help='图片宽度 (像素)')
    parser.add_argument('-H', '--height', type=int, help='图片高度 (像素)')
    parser.add_argument('-n', '--number', type=int, default=1, help='生成数量 (1-4, 默认: 1)')
    parser.add_argument('--no-watermark', action='store_true', help='不添加水印')
    parser.add_argument('--url', action='store_true', help='返回 URL 而不是下载图片')
    parser.add_argument('--list-models', action='store_true', help='列出支持的模型')
    parser.add_argument('--endpoint', default=DEFAULT_ENDPOINT, help='API 端点')
    parser.add_argument('--api-key', help='API Key (默认从环境变量读取)')
    parser.add_argument('--debug', action='store_true', help='开启调试模式')
    
    args = parser.parse_args()
    
    # 列出模型
    if args.list_models:
        list_models()
        return
    
    # 检查提示词
    if not args.prompt:
        parser.print_help()
        sys.exit(1)
    
    # 限制数量
    if args.number < 1 or args.number > 4:
        print("错误: 生成数量必须在 1-4 之间")
        sys.exit(1)
    
    # 调试模式
    if args.debug:
        print(f"[DEBUG] Endpoint: {args.endpoint}")
        print(f"[DEBUG] Model: {args.model}")
        print(f"[DEBUG] API Key: {(args.api_key or API_KEY)[:15]}..." if (args.api_key or API_KEY) else "[DEBUG] API Key: 未找到")
    
    try:
        print(f"🎨 正在生成图片...")
        print(f"   模型: {SUPPORTED_MODELS.get(args.model, args.model)}")
        print(f"   提示: {args.prompt[:60]}...")
        
        output_paths = generate_image(
            prompt=args.prompt,
            model=args.model,
            width=args.width,
            height=args.height,
            ratio=args.ratio,
            n=args.number,
            output_path=args.output,
            response_format="url" if args.url else "b64_json",
            watermark=not args.no_watermark,
            api_key=args.api_key,
            endpoint=args.endpoint
        )
        
        print(f"\n✅ 生成完成! 共 {len(output_paths)} 张图片")
        for path in output_paths:
            print(f"   📁 {path}")
        
    except Exception as e:
        print(f"\n❌ 错误: {e}")
        print("\n可能的解决方案:")
        print("  1. 确认 VOLCENGINE_IMAGE_API_KEY 已正确设置")
        print("  2. 检查模型名称是否正确")
        print("  3. 确认尺寸满足最小像素要求 (>= 3686400)")
        print("  4. 检查网络连接和 API 端点")
        sys.exit(1)


if __name__ == "__main__":
    main()
