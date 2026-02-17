#!/bin/bash
# Sync Square catalog to static JSON for the ordering page
REPO="/Users/oscarclark/.openclaw/workspace/proper-cinematic-soul"
OUT="$REPO/public/catalog.json"
SQUARE_TOKEN="EAAAl_nbTHyhNiycDMRqTy70H0MNY3KW8Lhjtw2MlNhlTjKx5W99Bk1cvopj67es"

cd "$REPO" || exit 1

python3 - "$SQUARE_TOKEN" "$OUT" << 'PYTHON'
import sys, json, urllib.request, datetime

token, out_path = sys.argv[1], sys.argv[2]

all_objects, cursor = [], None
# Fetch all catalog types including IMAGE
for types_param in ["", "types=IMAGE"]:
    cursor = None
    while True:
        url = "https://connect.squareup.com/v2/catalog/list"
        sep = "?"
        if types_param: url += f"?{types_param}"; sep = "&"
        if cursor: url += f"{sep}cursor={cursor}"
        req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}", "Square-Version": "2024-01-18", "Content-Type": "application/json"})
        with urllib.request.urlopen(req) as resp:
            data = json.loads(resp.read())
        all_objects.extend(data.get("objects", []))
        cursor = data.get("cursor")
        if not cursor: break

categories, images, modifier_lists, items = {}, {}, {}, []
for obj in all_objects:
    t = obj["type"]
    if t == "CATEGORY": categories[obj["id"]] = obj
    elif t == "IMAGE":
        u = (obj.get("image_data") or {}).get("url")
        if u: images[obj["id"]] = u
    elif t == "MODIFIER_LIST": modifier_lists[obj["id"]] = obj
    elif t == "ITEM": items.append(obj)

CAT = {"apps": ("small-plates", "Small Plates & Apps", 0), "small plates": ("small-plates", "Small Plates & Apps", 0),
       "salads": ("salads", "Salads", 1), "entree/land": ("entrees-land", "Entrees — Land", 2),
       "entree/sea": ("entrees-sea", "Entrees — Sea", 3), "pasta": ("pasta", "Pasta", 4),
       "brunch": ("brunch", "Brunch", 5), "sandwiches": ("sandwiches", "Sandwiches", 6),
       "protein": ("protein", "Proteins & Add-Ons", 7), "sides": ("sides", "Sides", 8),
       "desserts": ("desserts", "Desserts", 9)}

csm = {}
for cid, cat in categories.items():
    n = (cat.get("category_data", {}).get("name") or "").lower().strip()
    if n in CAT: csm[cid] = {"slug": CAT[n][0], "name": CAT[n][1], "order": CAT[n][2]}

tc = lambda s: " ".join(w.capitalize() for w in s.lower().split())

menu_items = []
for item in items:
    d = item.get("item_data", {})
    if d.get("is_archived"): continue
    cids = [c["id"] for c in d.get("categories", [])]
    if d.get("category_id"): cids.append(d["category_id"])
    ci = next((csm[c] for c in cids if c in csm), None)
    if not ci: continue
    vs = [{"id": v["id"], "name": (v.get("item_variation_data") or {}).get("name", "Regular"), "price": ((v.get("item_variation_data") or {}).get("price_money") or {}).get("amount", 0)} for v in d.get("variations", [])]
    iid = (d.get("image_ids") or [None])[0]
    menu_items.append({"id": item["id"], "name": tc(d.get("name", "")), "description": d.get("description"),
        "category": ci["slug"], "variations": vs, "modifierListIds": [m["modifier_list_id"] for m in d.get("modifier_list_info", [])],
        "imageUrl": images.get(iid) if iid else None, "price": vs[0]["price"] if vs else 0})

mls = [{"id": mid, "name": (ml.get("modifier_list_data") or {}).get("name", ""),
    "modifiers": [{"id": m["id"], "name": (m.get("modifier_data") or {}).get("name", ""), "price": ((m.get("modifier_data") or {}).get("price_money") or {}).get("amount", 0)} for m in (ml.get("modifier_list_data") or {}).get("modifiers", [])]}
    for mid, ml in modifier_lists.items()]

used = set(i["category"] for i in menu_items)
seen, cats_out = set(), []
for info in sorted(csm.values(), key=lambda x: x["order"]):
    if info["slug"] in used and info["slug"] not in seen:
        seen.add(info["slug"]); cats_out.append({"slug": info["slug"], "name": info["name"]})

with open(out_path, "w") as f:
    json.dump({"categories": cats_out, "menuItems": menu_items, "modifierLists": mls, "fetchedAt": datetime.datetime.utcnow().isoformat() + "Z"}, f, indent=2)
print(f"Wrote {len(menu_items)} items, {len(cats_out)} categories, {len(mls)} modifier lists")
PYTHON

cd "$REPO"
if git diff --quiet public/catalog.json 2>/dev/null; then echo "No changes"; exit 0; fi
git add public/catalog.json
git commit -m "chore: sync Square catalog (auto)"
git push origin main
echo "Catalog updated and pushed"
