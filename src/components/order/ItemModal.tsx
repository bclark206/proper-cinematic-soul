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
import { Minus, Plus, Check } from "lucide-react";
import {
  type MenuItem,
  type ModifierList,
  formatPrice,
  getModifierList,
} from "@/data/menu";
import type { CartItem, SelectedModifier } from "@/hooks/useCart";
import { cn } from "@/lib/utils";

interface ItemModalProps {
  item: MenuItem | null;
  open: boolean;
  onClose: () => void;
  onAddToCart: (item: Omit<CartItem, "cartItemId">) => void;
}

const ItemModal = ({ item, open, onClose, onAddToCart }: ItemModalProps) => {
  const [quantity, setQuantity] = useState(1);
  const [selectedModifiers, setSelectedModifiers] = useState<SelectedModifier[]>([]);
  const [specialInstructions, setSpecialInstructions] = useState("");

  if (!item) return null;

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
      // For "Two Choice Sides", limit to 2 selections
      const currentForList = prev.filter((m) => m.listId === list.id);
      if (list.name === "Choose Two Sides" && currentForList.length >= 2) {
        // Replace oldest selection
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
    // Reset
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
      <DialogContent className="bg-[#1a1a1a] border-gold/20 text-pure-white max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-display text-2xl text-pure-white">
            {item.name}
          </DialogTitle>
          <DialogDescription className="text-cream/60 text-base">
            {item.description || "A Proper Cuisine signature dish."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 mt-2">
          {/* Price */}
          <div className="text-gold font-semibold text-xl">
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
                <h4 className="font-display text-lg text-pure-white mb-1">
                  {list.name}
                </h4>
                {maxSelections && (
                  <p className="text-cream/40 text-xs mb-3">
                    Select up to {maxSelections} ({selectedForList.length}/{maxSelections})
                  </p>
                )}
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
                          "flex items-center justify-between px-3 py-2.5 rounded-lg text-sm transition-all duration-200 border",
                          isSelected
                            ? "border-gold bg-gold/15 text-gold"
                            : "border-gold/10 bg-gold/5 text-cream/70 hover:border-gold/30 hover:text-cream"
                        )}
                      >
                        <span className="truncate text-left">{mod.name}</span>
                        <span className="flex items-center gap-1 ml-2 shrink-0">
                          {mod.price > 0 && (
                            <span className="text-xs text-gold/60">
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
            <h4 className="font-display text-sm text-cream/60 mb-2">
              Special Instructions
            </h4>
            <Textarea
              value={specialInstructions}
              onChange={(e) => setSpecialInstructions(e.target.value)}
              placeholder="Allergies, preferences, modifications..."
              className="bg-gold/5 border-gold/10 text-cream placeholder:text-cream/30 focus:border-gold/40 resize-none"
              rows={2}
            />
          </div>

          {/* Quantity + Add to Cart */}
          <div className="flex items-center gap-4 pt-2">
            <div className="flex items-center border border-gold/20 rounded-lg overflow-hidden">
              <button
                onClick={() => setQuantity(Math.max(1, quantity - 1))}
                className="px-3 py-2.5 text-cream/70 hover:text-gold hover:bg-gold/10 transition-colors"
              >
                <Minus className="w-4 h-4" />
              </button>
              <span className="px-4 py-2.5 text-pure-white font-medium min-w-[3rem] text-center">
                {quantity}
              </span>
              <button
                onClick={() => setQuantity(quantity + 1)}
                className="px-3 py-2.5 text-cream/70 hover:text-gold hover:bg-gold/10 transition-colors"
              >
                <Plus className="w-4 h-4" />
              </button>
            </div>

            <Button
              variant="gold"
              size="lg"
              className="flex-1 text-base"
              onClick={handleAdd}
            >
              Add to Cart — {formatPrice(lineTotal)}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default ItemModal;
