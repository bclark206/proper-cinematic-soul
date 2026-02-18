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
      if (list.name.toLowerCase().includes("two") && list.name.toLowerCase().includes("side") && currentForList.length >= 2) {
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
      <DialogContent className="bg-[#111111] border-gold/15 text-pure-white w-[calc(100%-2rem)] max-w-lg max-h-[90vh] overflow-y-auto p-0 rounded-2xl sm:rounded-2xl mx-auto gap-0">
        {/* Hero Image — taller 4:3 aspect for visual prominence */}
        {imageUrl ? (
          <div className="relative w-full aspect-[4/3] overflow-hidden rounded-t-2xl flex-shrink-0">
            <img
              src={imageUrl}
              alt={item.name}
              className="w-full h-full object-cover"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-[#111111] via-[#111111]/20 to-transparent" />
          </div>
        ) : (
          <div className="relative w-full aspect-[3/2] bg-gradient-to-br from-[#1e1a14] via-[#181410] to-[#121010] rounded-t-2xl flex items-center justify-center flex-shrink-0">
            <UtensilsCrossed className="w-12 h-12 text-gold/15" />
          </div>
        )}

        {/* Content */}
        <div className="px-5 sm:px-6 pb-5 sm:pb-6 -mt-8 relative z-10">
          <DialogHeader className="mb-5">
            <div className="flex items-start justify-between gap-3">
              <DialogTitle className="font-display text-2xl sm:text-[1.75rem] text-pure-white leading-tight">
                {item.name}
              </DialogTitle>
              <span className="text-gold font-display font-semibold text-xl shrink-0 pt-0.5">
                {formatPrice(item.price)}
              </span>
            </div>
            <DialogDescription className="text-cream/60 text-[0.9rem] leading-relaxed mt-2">
              {item.description || "A Proper Cuisine signature dish."}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-5">
            {/* Modifier Lists */}
            {modifierLists.map((list) => {
              const selectedForList = selectedModifiers.filter(
                (m) => m.listId === list.id
              );
              const maxSelections = list.name.toLowerCase().includes("two") && list.name.toLowerCase().includes("side") ? 2 : undefined;

              return (
                <div key={list.id} className="border-t border-white/[0.06] pt-5">
                  <div className="flex items-center justify-between mb-3">
                    <h4 className="font-display text-sm font-medium text-cream/80 uppercase tracking-wider">
                      {list.name}
                    </h4>
                    {maxSelections && (
                      <span className={cn(
                        "text-xs font-medium px-2.5 py-1 rounded-full transition-colors",
                        selectedForList.length === maxSelections
                          ? "bg-gold/15 text-gold"
                          : "bg-white/[0.06] text-cream/40"
                      )}>
                        {selectedForList.length}/{maxSelections}
                      </span>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2">
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
                            "inline-flex items-center gap-1.5 px-3.5 py-2 rounded-full text-sm transition-all duration-200 border",
                            isSelected
                              ? "border-gold/60 bg-gold/10 text-gold"
                              : "border-[#2a2a2a] bg-[#161616] text-cream/60 hover:border-[#3a3a3a] hover:text-cream/80"
                          )}
                        >
                          {isSelected && <Check className="w-3 h-3" />}
                          <span>{mod.name}</span>
                          {mod.price > 0 && (
                            <span className={cn(
                              "text-xs",
                              isSelected ? "text-gold/70" : "text-cream/30"
                            )}>
                              +{formatPrice(mod.price)}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}

            {/* Special Instructions */}
            <div className="border-t border-white/[0.06] pt-5">
              <h4 className="font-display text-sm font-medium text-cream/80 uppercase tracking-wider mb-3">
                Special Instructions
              </h4>
              <Textarea
                value={specialInstructions}
                onChange={(e) => setSpecialInstructions(e.target.value)}
                placeholder="Allergies, preferences, modifications..."
                className="bg-[#161616] border-[#2a2a2a] text-cream placeholder:text-cream/25 focus:border-gold/40 resize-none rounded-xl text-sm"
                rows={2}
              />
            </div>

            {/* Quantity + Add to Cart — sticky bottom feel */}
            <div className="flex items-center gap-3 pt-2">
              <div className="flex items-center border border-[#2a2a2a] rounded-full overflow-hidden bg-[#161616]">
                <button
                  onClick={() => setQuantity(Math.max(1, quantity - 1))}
                  className="px-3.5 py-2.5 text-cream/60 hover:text-gold hover:bg-gold/10 transition-colors"
                  aria-label="Decrease quantity"
                >
                  <Minus className="w-4 h-4" />
                </button>
                <span className="px-3 py-2.5 text-pure-white font-semibold min-w-[2.5rem] text-center text-sm tabular-nums">
                  {quantity}
                </span>
                <button
                  onClick={() => setQuantity(quantity + 1)}
                  className="px-3.5 py-2.5 text-cream/60 hover:text-gold hover:bg-gold/10 transition-colors"
                  aria-label="Increase quantity"
                >
                  <Plus className="w-4 h-4" />
                </button>
              </div>

              <Button
                variant="gold"
                size="lg"
                className="flex-1 text-sm font-semibold rounded-full h-[46px]"
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
