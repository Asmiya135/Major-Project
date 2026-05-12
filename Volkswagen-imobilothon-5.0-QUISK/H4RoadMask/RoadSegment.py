import os
import cv2
from ultralytics import YOLO
from pathlib import Path

BASE_DIR      = Path(__file__).parent
MODEL_PATH    = str(BASE_DIR / "model" / "yolo11n-seg.pt")
INPUT_FOLDER  = str(BASE_DIR / "input")
OUTPUT_FOLDER = str(BASE_DIR / "output_RoadSegment")

os.makedirs(OUTPUT_FOLDER, exist_ok=True)
print("Loading YOLOv11 segmentation model...")
model = YOLO(MODEL_PATH)
print("Model loaded.")

VEHICLE_CLASSES = {2, 3, 5, 7}  # car, motorcycle, bus, truck

for file in os.listdir(INPUT_FOLDER):
    if not file.lower().endswith((".jpg", ".png", ".jpeg")):
        continue
    img_path = os.path.join(INPUT_FOLDER, file)
    print(f"\nProcessing {file}...")
    results   = model(img_path, conf=0.3)
    annotated = results[0].plot()
    cv2.imwrite(os.path.join(OUTPUT_FOLDER, file.replace(".jpg", "_annotated.jpg")), annotated)
    boxes = results[0].boxes
    if boxes is not None and len(boxes) > 0:
        for i, cls in enumerate(boxes.cls):
            if int(cls) in VEHICLE_CLASSES:
                label = results[0].names[int(cls)]
                print(f"  Detected: {label} (conf={boxes.conf[i]:.2f})")
    else:
        print("  No vehicles detected.")

print("\nVehicle segmentation complete.")
print(f"Results saved in: {OUTPUT_FOLDER}")
