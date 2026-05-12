from ultralytics import YOLO
import cv2
import numpy as np
import os
from pathlib import Path

BASE_DIR      = Path(__file__).parent
model_path    = BASE_DIR / "model" / "YoloV8Segmented.pt"
input_folder  = BASE_DIR / "input"
output_folder = BASE_DIR / "segmented_area_output"

os.makedirs(output_folder, exist_ok=True)
model = YOLO(str(model_path))

for file_name in os.listdir(input_folder):
    if not file_name.lower().endswith(('.jpg', '.png', '.jpeg')):
        continue
    image_path = input_folder / file_name
    print(f"\n Processing: {file_name}")
    results = model.predict(source=str(image_path), conf=0.5, save=False, verbose=False)
    img = cv2.imread(str(image_path))
    if len(results) == 0 or results[0].masks is None:
        print("No potholes detected.")
        continue
    masks = results[0].masks.data.cpu().numpy()
    for i, mask in enumerate(masks):
        area_pixels = int(np.sum(mask > 0.5))
        mask_resized = cv2.resize(mask, (img.shape[1], img.shape[0]),
                                   interpolation=cv2.INTER_NEAREST)
        y, x = np.where(mask_resized > 0.5)
        if len(x) == 0 or len(y) == 0:
            continue
        cx, cy = int(np.mean(x)), int(np.mean(y))
        color   = (0, 0, 255)
        mask_vis = np.stack((mask_resized,)*3, axis=-1)
        img = np.where(mask_vis, img * 0.5 + np.array(color) * 0.5, img).astype(np.uint8)
        cv2.putText(img, f"Area: {area_pixels}px", (cx-60, cy),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 255), 2, cv2.LINE_AA)
        print(f"  Pothole {i+1}: Area = {area_pixels} px")
    output_path = output_folder / file_name
    cv2.imwrite(str(output_path), img)
    print(f"Saved: {output_path}")

print("\nAll images processed.")
