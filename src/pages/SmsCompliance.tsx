import React, { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { ArrowLeft, MessageSquare, Shield, Clock } from "lucide-react";
import { Link } from "react-router-dom";

const formSchema = z.object({
  phoneNumber: z.string()
    .min(10, "Please enter a valid phone number")
    .regex(/^\+?1?[2-9]\d{2}[2-9]\d{2}\d{4}$/, "Please enter a valid US phone number"),
  consent: z.boolean().refine((val) => val === true, "You must agree to receive SMS messages"),
});

const SmsCompliance = () => {
  const [isSubmitted, setIsSubmitted] = useState(false);
  const { toast } = useToast();

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      phoneNumber: "",
      consent: false,
    },
  });

  const onSubmit = (values: z.infer<typeof formSchema>) => {
    console.log("SMS opt-in form submitted:", values);
    setIsSubmitted(true);
    toast({
      title: "Success!",
      description: "You've been added to our SMS marketing list. Text CUISINE to 12345 to get started!",
    });
  };

  if (isSubmitted) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-jet-black via-charcoal to-jet-black">
        <div className="container mx-auto px-6 py-12">
          <Link 
            to="/" 
            className="inline-flex items-center text-gold hover:text-gold/80 transition-colors mb-8"
          >
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back to Home
          </Link>
          
          <div className="max-w-2xl mx-auto text-center">
            <div className="mb-8">
              <div className="w-20 h-20 bg-gold/20 rounded-full flex items-center justify-center mx-auto mb-6">
                <MessageSquare className="w-10 h-10 text-gold" />
              </div>
              <h1 className="text-4xl font-display font-bold text-pure-white mb-4">
                You're All Set!
              </h1>
              <p className="text-xl text-cream mb-8">
                Welcome to Proper Cuisine SMS updates
              </p>
            </div>

            <div className="bg-charcoal/50 rounded-lg p-8 border border-gold/20 mb-8">
              <h2 className="text-2xl font-semibold text-gold mb-4">Next Step</h2>
              <p className="text-cream text-lg mb-6">
                To complete your subscription and start receiving exclusive offers:
              </p>
              <div className="bg-jet-black/50 rounded-lg p-6 border border-gold/30">
                <p className="text-pure-white text-xl font-semibold">
                  Text <span className="text-gold font-bold">CUISINE</span> to <span className="text-gold font-bold">12345</span>
                </p>
              </div>
            </div>

            <div className="grid md:grid-cols-3 gap-6 mb-8">
              <div className="text-center">
                <Shield className="w-8 h-8 text-gold mx-auto mb-3" />
                <h3 className="font-semibold text-pure-white mb-2">Secure</h3>
                <p className="text-cream text-sm">Your information is protected</p>
              </div>
              <div className="text-center">
                <MessageSquare className="w-8 h-8 text-gold mx-auto mb-3" />
                <h3 className="font-semibold text-pure-white mb-2">Exclusive</h3>
                <p className="text-cream text-sm">Special offers & updates</p>
              </div>
              <div className="text-center">
                <Clock className="w-8 h-8 text-gold mx-auto mb-3" />
                <h3 className="font-semibold text-pure-white mb-2">Timely</h3>
                <p className="text-cream text-sm">Real-time notifications</p>
              </div>
            </div>

            <p className="text-cream/80 text-sm">
              You can opt out anytime by texting STOP to 12345
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-jet-black via-charcoal to-jet-black">
      <div className="container mx-auto px-6 py-12">
        <Link 
          to="/" 
          className="inline-flex items-center text-gold hover:text-gold/80 transition-colors mb-8"
        >
          <ArrowLeft className="w-4 h-4 mr-2" />
          Back to Home
        </Link>
        
        <div className="max-w-2xl mx-auto">
          <div className="text-center mb-12">
            <h1 className="text-4xl md:text-5xl font-display font-bold text-pure-white mb-6">
              Join Our SMS List
            </h1>
            <p className="text-xl text-cream">
              Get exclusive offers, event updates, and culinary news delivered straight to your phone
            </p>
          </div>

          <div className="bg-charcoal/50 rounded-lg p-8 border border-gold/20 mb-8">
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
                <FormField
                  control={form.control}
                  name="phoneNumber"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-pure-white font-semibold">Phone Number</FormLabel>
                      <FormControl>
                        <Input 
                          placeholder="(555) 123-4567" 
                          {...field}
                          className="bg-jet-black/50 border-gold/30 text-pure-white placeholder:text-cream/50"
                        />
                      </FormControl>
                      <FormDescription className="text-cream/70">
                        Enter your mobile phone number to receive SMS updates
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="consent"
                  render={({ field }) => (
                    <FormItem className="flex flex-row items-start space-x-3 space-y-0">
                      <FormControl>
                        <Checkbox
                          checked={field.value}
                          onCheckedChange={field.onChange}
                        />
                      </FormControl>
                      <div className="space-y-1 leading-none">
                        <FormLabel className="text-pure-white font-semibold">
                          SMS Marketing Consent
                        </FormLabel>
                        <FormDescription className="text-cream/70">
                          I agree to receive promotional SMS messages from Proper Cuisine. 
                          Message frequency varies. Message and data rates may apply. 
                          Reply STOP to opt out or HELP for help.
                        </FormDescription>
                        <FormMessage />
                      </div>
                    </FormItem>
                  )}
                />

                <Button 
                  type="submit" 
                  className="w-full" 
                  variant="gold"
                  size="lg"
                >
                  Join SMS List
                </Button>
              </form>
            </Form>
          </div>

          <div className="bg-jet-black/30 rounded-lg p-6 border border-gold/10">
            <h3 className="text-lg font-semibold text-gold mb-4">What to Expect</h3>
            <ul className="space-y-3 text-cream">
              <li className="flex items-start">
                <span className="text-gold mr-2">•</span>
                <span>Exclusive restaurant promotions and special offers</span>
              </li>
              <li className="flex items-start">
                <span className="text-gold mr-2">•</span>
                <span>Private event and tasting menu announcements</span>
              </li>
              <li className="flex items-start">
                <span className="text-gold mr-2">•</span>
                <span>Chef's special dishes and seasonal menu updates</span>
              </li>
              <li className="flex items-start">
                <span className="text-gold mr-2">•</span>
                <span>Limited-time reservations and VIP experiences</span>
              </li>
            </ul>
          </div>

          <div className="mt-8 text-center">
            <p className="text-cream/60 text-sm">
              By providing your phone number, you agree to our{" "}
              <Link to="/terms-conditions" className="text-gold hover:underline">Terms & Conditions</Link> and{" "}
              <Link to="/privacy-policy" className="text-gold hover:underline">Privacy Policy</Link>.
              You can unsubscribe at any time by texting STOP.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default SmsCompliance;