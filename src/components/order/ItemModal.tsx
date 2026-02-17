import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Minus, Plus, Check, UtensilsCrossed } from "lucide-react";
import {
  type MenuItem,
  type ModifierList,
  formatPrice,
} from "@/data/menu";
import type { CartItem, SelectedModifier } from "@/hooks/useCart";
import { cn } from "@/lib/utils";

interface ItemModalProps {
  item: MenuItem | null;
  open: boolean;
  onClose: () => void;
  onAddToCart: (item: Omit<CartItem, "cartItemId">) => void;
  getModifierList: (id: string) => ModifierList | undefined;
  getItemImageUrl: (imageId: string | null) => string | null;
}

const ItemModal = ({ item, open, onClose, onAddToCart, getModifierList, getItemImageUrl }: ItemModalProps) => {
  const [quantity, setQuantity] = useState(1);
  const [selectedModifiers, setSelectedModifiers] = useState<SelectedModifier[]>([]);
  const [specialInstructions, setSpecialInstructions] = useState("");

  if (!item) return null;

  const imageUrl = (item as any).imageUrl || getItemImageUrl(item.imageId);

  const modifierLists: ModifierList[] = item.modifierListIds
    .map((id) => getModifierList(id))
    .filter(Boolean) as ModifierList[];

  const toggleModifier = (list: ModifierList, modId: string, modName: string, modPrice: number) => {
    setSelectedModifiers((prev) => {
      const exists = prev.find(
        (m) => m.listId === list.id && m.modifierId === modId
      );
      if (exists) {
        return prev.filter(
          (m) => !(m.listId === list.id && m.modifierId === modId)
        );
      }
      const currentForList = prev.filter((m) => m.listId === list.id);
      if (list.name === "Choose Two Sides" && currentForList.length >= 2) {
        const withoutOldest = prev.filter(
          (m) => !(m.listId === list.id && m.modifierId === currentForList[0].modifierId)
        );
        return [
          ...withoutOldest,
          { listId: list.id, listName: list.name, modifierId: modId, modifierName: modName, price: modPrice },
        ];
      }
      return [
        ...prev,
        { listId: list.id, listName: list.name, modifierId: modId, modifierName: modName, price: modPrice },
      ];
    });
  };

  const modifierTotal = selectedModifiers.reduce((s, m) => s + m.price, 0);
  const lineTotal = (item.price + modifierTotal) * quantity;

  const handleAdd = () => {
    onAddToCart({
      itemId: item.id,
      variationId: item.variations[0].id,
      name: item.name,
      basePrice: item.price,
      quantity,
      modifiers: selectedModifiers,
      specialInstructions,
    });
    setQuantity(1);
    setSelectedModifiers([]);
    setSpecialInstructions("");
    onClose();
  };

  const handleOpenChange = (isOpen: boolean) => {
    if (!isOpen) {
      setQuantity(1);
      setSelectedModifiers([]);
      setSpecialInstructions("");
      onClose();
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="bg-[#111111] border-gold/15 text-pure-white max-w-lg max-h-[90vh] overflow-y-auto p-0 rounded-2xl">
        {/* Item Image */}
        {imageUrl ? (
          <div className="relative w-full aspect-[16/9] overflow-hidden rounded-t-2xl">
            <img
              src={imageUrl}
              alt={item.name}
              className="w-full h-full object-cover"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-[#111111] via-transparent to-transparent" />
          </div>
        ) : (
          <div className="relative w-full h-32 bg-gradient-to-br from-[#1e1a14] via-[#181410] to-[#121010] rounded-t-2xl flex items-center justify-center">
            <UtensilsCrossed className="w-10 h-10 text-gold/15" />
          </div>
        )}

        <div className="px-6 pb-6">
          <DialogHeader className="mb-4">
            <DialogTitle className="font-display text-2xl text-pure-white leading-tight">
              {item.name}
            </DialogTitle>
            <DialogDescription className="text-cream/50 text-sm mt-1">
              {item.description || "A Proper Cuisine signature dish."}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-6">
            {/* Price */}
            <div className="text-gold font-display font-semibold text-xl">
              {formatPrice(item.price)}
            </div>

            {/* Modifier Lists */}
            {modifierLists.map((list) => {
              const selectedForList = selectedModifiers.filter(
                (m) => m.listId === list.id
              );
              const maxSelections = list.name === "Choose Two Sides" ? 2 : undefined;

              return (
                <div key={list.id}>
                  <div className="flex items-center justify-between mb-3">
                    <h4 className="font-display text-base font-medium text-pure-white">
                      {list.name}
                    </h4>
                    {maxSelections && (
                      <span className="text-gold/60 text-xs bg-gold/8 px-2 py-0.5 rounded-full">
                        {selectedForList.length}/{maxSelections}
                      </span>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {list.modifiers.map((mod) => {
                      const isSelected = selectedForList.some(
                        (m) => m.modifierId === mod.id
                      );
                      return (
                        <button
                          key={mod.id}
                          onClick={() =>
                            toggleModifier(list, mod.id, mod.name, mod.price)
                          }
                          className={cn(
                            "flex items-center justify-between px-3 py-2.5 rounded-xl text-sm transition-all duration-200 border",
                            isSelected
                              ? "border-gold bg-gold/10 text-gold shadow-[0_0_12px_rgba(197,168,106,0.1)]"
                              : "border-[#2a2a2a] bg-[#1a1a1a] text-cream/60 hover:border-gold/30 hover:text-cream"
                          )}
                        >
                          <span className="truncate text-left">{mod.name}</span>
                          <span className="flex items-center gap-1 ml-2 shrink-0">
                            {mod.price > 0 && (
                              <span className="text-xs text-gold/50">
                                +{formatPrice(mod.price)}
                              </span>
                            )}
                            {isSelected && <Check className="w-3.5 h-3.5 text-gold" />}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}

            {/* Special Instructions */}
            <div>
              <h4 className="text-sm font-medium text-cream/50 mb-2">
                Special Instructions
              </h4>
              <Textarea
                value={specialInstructions}
                onChange={(e) => setSpecialInstructions(e.target.value)}
                placeholder="Allergies, preferences, modifications..."
                className="bg-[#1a1a1a] border-[#2a2a2a] text-cream placeholder:text-cream/25 focus:border-gold/40 resize-none rounded-xl"
                rows={2}
              />
            </div>

            {/* Quantity + Add to Cart */}
            <div className="flex items-center gap-3 pt-2">
              <div className="flex items-center border border-[#2a2a2a] rounded-xl overflow-hidden bg-[#1a1a1a]">
                <button
                  onClick={() => setQuantity(Math.max(1, quantity - 1))}
                  className="px-3.5 py-3 text-cream/60 hover:text-gold hover:bg-gold/10 transition-colors"
                >
                  <Minus className="w-4 h-4" />
                </button>
                <span className="px-4 py-3 text-pure-white font-semibold min-w-[3rem] text-center text-base">
                  {quantity}
                </span>
                <button
                  onClick={() => setQuantity(quantity + 1)}
                  className="px-3.5 py-3 text-cream/60 hover:text-gold hover:bg-gold/10 transition-colors"
                >
                  <Plus className="w-4 h-4" />
                </button>
              </div>

              <Button
                variant="gold"
                size="lg"
                className="flex-1 text-base font-semibold rounded-xl h-[50px]"
                onClick={handleAdd}
              >
                Add to Cart — {formatPrice(lineTotal)}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default ItemModal;
