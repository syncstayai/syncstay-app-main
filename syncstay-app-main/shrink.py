import os
from PIL import Image

# This will look at your public folder where the images are
input_folder = "public" 

for filename in os.listdir(input_folder):
    # Make sure we only check image files
    if filename.lower().endswith((".png", ".jpg", ".jpeg")):
        filepath = os.path.join(input_folder, filename)
        
        try:
            # Open the image
            img = Image.open(filepath)
            
            # FIX 1: Convert RGBA to RGB
            # JPEGs don't support transparency. This "flattens" the image.
            if img.mode != 'RGB':
                img = img.convert('RGB')
            
            # 1. Resize it (1200px is plenty for a phone screen)
            base_width = 1200
            w_percent = (base_width / float(img.size[0]))
            h_size = int((float(img.size[1]) * float(w_percent)))
            img = img.resize((base_width, h_size), Image.LANCZOS)
            
            # 2. Save it with compression (Optimized)
            img.save(filepath, "JPEG", optimize=True, quality=70)
            print(f"✅ Compressed {filename}")
            
        except Exception as e:
            # FIX 2: Skip broken or unidentified files instead of crashing
            print(f"❌ Skipped {filename} due to error: {e}")

print("\n--- All done! Check your public folder sizes now. ---")